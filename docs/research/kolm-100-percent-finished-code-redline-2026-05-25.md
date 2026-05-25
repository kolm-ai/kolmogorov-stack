# Kolm 100 Percent Finished Code Redline

Date: 2026-05-25

Audience: internal implementation agents only.

This is not a test plan. This is not another research seed. This is the code-finish redline: the implementation work required before anyone can honestly say the Kolm codebase is 100 percent finished.

Tests, screenshots, scans, and generated ledgers are proof mechanisms. They are not the work. The work is finishing, cleaning, integrating, deleting, shipping, and proving real product behavior.

This document does not certify completion. It names what is still blocking completion from the codebase point of view.

## Implementation-Only Redline Contract

This document is now implementation-first. Do not add another passive inventory section unless it directly creates a code redline. Every new row must be one of these actions:

- `CREATE`: add a missing module, manifest, generator, page shell, route wrapper, state machine, or package boundary.
- `REPLACE`: remove manual, duplicated, stale, or wave-coded behavior and make one canonical implementation own it.
- `DELETE`: remove scratch, dead, mock-only, duplicate, generated-sprawl, archive, or legacy-name code from the release surface.
- `MOVE`: relocate generated, archive, report, cache, local data, or fixture files into their correct source-boundary class.
- `IMPLEMENT`: finish real runtime behavior behind a route, CLI command, worker, account page, docs example, or product proof component.
- `WIRE`: connect implementation to product graph, OpenAPI, account UI, CLI help, docs, telemetry, release evidence, and generated page metadata.

The required format is:

```text
REDLINE: <broken or missing implementation>
ACTION: <CREATE|REPLACE|DELETE|MOVE|IMPLEMENT|WIRE> <exact files/modules>
CODE: <concrete implementation shape>
EXIT: <behavior that exists after the code change>
```

Do not write "review", "scan", "audit", "consider", "improve", or "verify" as the action. Those are allowed only in the `EXIT` line after implementation exists.

## Master Spec Tree And Contract Encoding Redline

Direct answer: no, all of this should not be JSON.

Current local reality after reviewing the live repo:

- The backend is Node ESM JavaScript, not TypeScript and not a separate non-JS backend stack. `package.json` declares `"type": "module"`, route/runtime code lives primarily under `src/`, CLI under `cli/`, and scripts are mixed ESM/CJS.
- JSON is already used correctly as generated evidence in several places: `public/product-graph.json`, `docs/internal/codebase-file-ledger.json`, `docs/internal/design-cascade-ledger.json`, `docs/internal/product-media-proof.json`, `docs/internal/catalog-manifest.json`, and `docs/internal/wave-registry.json`.
- JSON is also used correctly as wire/interchange data: API responses, OpenAPI output, JSON Schema files, `.kolm` artifact internals such as `manifest.json`, `recipes.json`, `evals.json`, and receipts.
- JSON is used as local/offline persistence in places where it should stay demoted: `src/store.js` defaults to local JSON files for dependency-free development but switches production-like environments toward SQLite when available; `src/event-store.js` uses SQLite as the main event path and JSONL as the fallback.
- The dangerous pattern is not "JSON exists." The dangerous pattern is hand-authored JSON being treated as runtime truth for behavior, policy, mutable state, pricing, routes, auth, or product completion.

REDLINE: the current spec language creates too many future `docs/internal/*.json` files without consistently saying whether they are source authority, generated projection, static browser payload, persistence fallback, or evidence.
ACTION: CREATE `docs/internal/contract-encoding-policy.md`, `src/contracts/contract-registry.js`, `src/contracts/schema-registry.js`, `src/contracts/policy-registry.js`, `src/contracts/projection-writers.js`, and `scripts/build-contract-projections.cjs`; REPLACE any redline that treats `docs/internal/*.json` as behavioral source of truth with a declared source/projection split.
CODE: every contract-like artifact must declare:

```json
{
  "id": "kolm.example_contract.v1",
  "source_kind": "code_authority|schema_authority|policy_authority|database_authority|artifact_authority|human_decision_record|generated_projection|runtime_cache|dev_fallback_store",
  "source_paths": ["src/..."],
  "projection_paths": ["docs/internal/...json", "public/...json"],
  "generator": "scripts/...",
  "validator": "scripts/... --check",
  "runtime_enforcer": "src/...",
  "mutable": false,
  "customer_visible": false,
  "secret_values_included": false
}
```

EXIT: no implementation agent can confuse a generated JSON ledger with the behavior, state, or policy it describes.

REDLINE: the master spec tree is split across prose, generated JSON, route scraping, product graph output, account pages, and package scripts without one explicit authority hierarchy.
ACTION: CREATE a master spec authority tree and WIRE every site/product surface to it.
CODE: the hierarchy must be:

| layer | authority | generated/public projection |
|---|---|---|
| Product vocabulary | `src/product-kernel.js` | `public/product-graph.json` kernel section |
| Product journeys and UX surface map | `src/product-experience.js` | product graph, account overview, CLI/TUI surface output |
| Route/API behavior | `src/api/route-contracts.js` and route modules | `public/openapi.json`, `public/docs/api-routes.json`, API docs |
| Request/response validation | JSON Schema 2020-12 schemas exported from `src/api/schemas/*` | OpenAPI schema components, SDK fixtures |
| Error model | `src/api/problem.js` using RFC 9457 problem details | API docs, SDK typed errors, account/CLI error renderers |
| Mutable tenant/account/data state | SQLite/Postgres migrations and repositories | JSON state snapshots/evidence only |
| Event stream and audit log | append-only event store and event schema modules | CloudEvents/AsyncAPI-style docs, SIEM export, JSONL fallback |
| Authorization and governance policy | code-backed policy engine, or Cedar/Rego if externalized | policy matrix JSON and docs |
| Pricing/commercial rules | `src/commercial/*` modules and billing state machine | pricing pages, ROI JSON, plan API responses |
| Provider/model/runtime/device catalog | source modules plus dated upstream evidence | `docs/internal/catalog-manifest.json`, public model/runtime pages |
| Website/page design system | design tokens, component CSS/JS modules, page-family contracts | design cascade ledger, screenshots, media proof |
| Artifact format | `.kolm` container spec and canonical artifact code | manifest/receipt JSON inside artifact, public spec page |
| Release proof | deploy packet, smoke results, screenshots, rollback evidence | production evidence JSON/Markdown report |

EXIT: `kolm.ai` becomes one system: product kernel -> route contracts -> UI/account/docs -> generated projections -> proof packets.

REDLINE: the site/product spec currently risks optimizing public pages separately from the actual product matrix.
ACTION: REPLACE page-by-page copy/design drift with a site master spec that owns all surfaced product promises.
CODE: the master site spec must map every public and account surface to one of the three product loops:

1. `route-and-capture`: OpenAI-compatible traffic capture, provider choice, privacy lake, cost/latency proof, zero-retention controls.
2. `distill-and-compile`: dataset promotion, teacher/student strategy, K-Score, eval gates, quantization, signed `.kolm` artifact build.
3. `run-and-govern`: runtime/device/cloud deployment, BYOC/storage, audit receipts, account readiness, enterprise controls.

Each page-family contract must declare `first_screen_claim`, `primary_action`, `proof_component`, `demo_or_media`, `account_destination`, `api_cli_docs_destination`, `readiness_scope`, `seo_title`, `structured_data`, `theme_states`, `mobile_states`, and `empty_error_loading_states`.
EXIT: homepage, product pages, docs, pricing, trust, demos, API docs, SDK docs, and post-auth account pages all tell the same product story instead of competing with each other.

REDLINE: "more serious than JSON" is being treated as a binary choice, but the serious choice is domain-specific authority.
ACTION: IMPLEMENT the following format policy instead of changing every artifact to one format.
CODE:

| domain | use this as authority | why | JSON role |
|---|---|---|---|
| HTTP contracts | code route contracts plus JSON Schema 2020-12 | runtime can enforce the same contract docs publish | OpenAPI/docs/SDK projection |
| Public static manifests | generated JSON | browser, CLI, and docs can consume it directly | primary projection, not behavior |
| Mutable app state | SQLite/Postgres repositories and migrations | transactions, constraints, migration history, recovery | export/snapshot only |
| Append-only events | SQLite/event log with schema module | auditability, replay, ordering, partial-write safety | JSONL fallback and CloudEvents payload |
| Authorization | policy engine/code relation model | deny/allow logic must be testable and centrally enforced | generated policy matrix |
| Cross-language binary SDK/runtime protocol | Protocol Buffers only when language-neutral binary compatibility is actually needed | smaller/faster, generated bindings, explicit schema | JSON debug projection |
| Artifact manifests and receipts | canonical deterministic JSON inside signed `.kolm` container | inspectable, hashable, portable, auditable | valid authority for artifact metadata |
| Large tensors/weights | safetensors/GGUF/ONNX/CoreML/etc. | JSON is wrong for large numeric arrays | metadata pointer only |
| Long-running jobs/streams | job state machine plus event stream contract | progress, cancellation, retry, partial failure need state semantics | JSON event payloads only |
| Human planning/redlines | Markdown plus generated extracted packets | humans need rationale and implementation language | generated index/projection only |

EXIT: Kolm uses JSON where JSON is strong and stops using JSON where it creates fake rigor.

REDLINE: the local control files prove the JSON/projection model is useful but also expose unfinished master-spec work.
ACTION: WIRE current generated ledgers into a single final build redline packet.
CODE: consume these current live artifacts:

- `public/product-graph.json`: 12 journeys, 8 customization dimensions, 582 routes, 163 route groups, 64 CLI commands, 32 TUI views.
- `docs/internal/codebase-file-ledger.json`: 3,673 paths, 2,509 source paths, 228 generated paths, 569 test paths, 0 unowned paths.
- `docs/internal/design-cascade-ledger.json`: 729 public HTML pages, 19 CSS files, 3,873 CSS `!important` uses, 1,524 raw CSS hex values, 75 negative letter-spacing uses, 3,215 inline HTML styles.
- `docs/internal/product-media-proof.json`: 729 HTML pages, 3,710 media references, 0 missing local media, 4 image dimension gaps.
- `docs/internal/catalog-manifest.json`: 132 catalog entries across providers, provider models, local models, devices, hardware, and runtimes.
- `docs/internal/wave-registry.json`: 551 waves, 450 local-green states, 93 planned states, 323 test-only waves, 93 plan-only waves.

EXIT: the master spec stops being "a pile of JSON" and becomes a control plane: source authority, generated projection, runtime enforcement, visible product surface, and final proof all connected.

REDLINE: the repo has no TypeScript project today, so demanding "serious" by switching everything to TypeScript would be a separate migration, not an immediate product finish.
ACTION: CREATE a typed-contract bridge before any TypeScript migration.
CODE: add JSDoc/type declarations, JSON Schema validation, generated `.d.ts` files for SDK consumers, and contract tests around JS modules first. Only migrate route contracts, schema registries, SDK generation, and high-churn product catalogs to TypeScript after the build can enforce mixed JS/TS without slowing release work.
EXIT: Kolm gets typed boundaries without a risky whole-repo language rewrite.

## Hard Implementation Redlines

These are the redlines an implementation agent should execute first. They are not research tasks.

### API And Backend Redlines

REDLINE: `src/router.js` is the de facto API backend, but route behavior is not owned by a strict route contract.
ACTION: CREATE `src/api/route-contracts.js`, `src/api/register-route.js`, `src/api/problem.js`, and `src/api/idempotency.js`; REPLACE direct `app.get/post/put/patch/delete` registrations in `src/router.js` with a contract-aware registration helper.
CODE: every route registration must pass `surface`, `journey`, `owner`, `auth`, `tenant_scope`, `object_auth`, `rate_limit`, `resource_limit`, `idempotency`, `request_schema`, `response_schema`, `errors`, `audit_event`, `openapi`, `sdk_exposure`, `account_exposure`, and `cli_exposure`. The helper rejects missing fields at startup unless the route is explicitly `public_static`, `health`, or `local_fixture`.
EXIT: a new API route cannot exist without auth/security/schema/error/openapi/product ownership.

REDLINE: API error output is still route-local and inconsistent.
ACTION: REPLACE route-local error JSON with `problem()` plus Kolm envelope extensions from `src/api/problem.js`.
CODE: implement RFC 9457-compatible fields `type`, `title`, `status`, `detail`, `instance`, plus extension fields `code`, `request_id`, `surface`, `journey`, `retryable`, `next_action`, `docs_url`, `account_url`, `support_ref`, and `redaction`. Preserve old fields only as compatibility aliases during one release window.
EXIT: account pages, CLI, SDKs, and API docs can render errors without string parsing.

REDLINE: mutating routes can be retried unsafely or ambiguously.
ACTION: IMPLEMENT idempotency policy in `src/api/idempotency.js` and WIRE it into every POST/PUT/PATCH/DELETE contract.
CODE: classify each mutating route as `requires_key`, `accepts_key`, `rejects_key`, or `non_retryable`; store replay keys with method, path, tenant, actor, body hash, response hash, expiry, and conflict status; return a typed conflict problem when replay body differs.
EXIT: create/promote/deploy/delete/purge/rotate operations are either safely replayable or explicitly non-retryable.

REDLINE: OpenAPI and generated API docs expose paths but do not fully describe security, request bodies, known errors, and state scope.
ACTION: REPLACE `scripts/build-api-ref.cjs` and `scripts/build-openapi.cjs` inputs with the route contract registry.
CODE: OpenAPI operations must include `security` or explicit public `security: []`, `requestBody` or explicit empty-body marker for mutating routes, success response schema, known problem responses, examples, tags from product surface, and `x-kolm-*` extensions for tenant scope, idempotency, local-only/external-gated state, and account/CLI/docs links.
EXIT: `public/openapi.json`, `public/docs/api-routes.json`, and `public/docs/api.html` are generated from runtime route contracts, not comments or stale route scraping.

REDLINE: tenant/object/function authorization is not a first-class backend primitive.
ACTION: CREATE `src/api/authorization-policy.js` and REPLACE per-route ad hoc checks with policy calls.
CODE: policies must cover tenant, team, artifact, capture, dataset, lake, key, billing, storage object, tunnel, deploy, approval, and audit resources; every policy returns allow/deny/reason/audit fields and supports account role, API key scope, plan, region, and local/dev mode.
EXIT: object IDs in routes cannot bypass authorization with only authentication.

REDLINE: `src/router.js` is too large to maintain safely.
ACTION: MOVE route families into `src/routes/account.js`, `src/routes/capture.js`, `src/routes/distill.js`, `src/routes/artifacts.js`, `src/routes/runtime.js`, `src/routes/storage.js`, `src/routes/billing.js`, `src/routes/governance.js`, `src/routes/docs.js`, and `src/routes/public.js`.
CODE: each module exports route contracts; `src/router.js` only installs middleware, imports route modules, registers contracts, and exposes the route registry for docs/OpenAPI/product graph.
EXIT: backend code can be changed by product surface without editing a 900 KB monolith.

#### API Contract Implementation Blueprint

CREATE `src/api/route-contracts.js` as code, not data-only docs:

```js
export const AUTH = {
  public: 'public',
  api_key: 'api_key',
  account_session: 'account_session',
  admin: 'admin',
  service: 'service',
};

export const IDEMPOTENCY = {
  none: 'none',
  accepts_key: 'accepts_key',
  requires_key: 'requires_key',
  rejects_key: 'rejects_key',
  non_retryable: 'non_retryable',
};

export function defineRoute(contract) {
  // Validate every required field at import/startup time.
  // Freeze the returned contract so route metadata cannot drift after registration.
}

export function getRouteContracts() {
  // Return the registry consumed by router, OpenAPI, API docs, SDK docs, account matrix, and product graph.
}
```

Every route module must export contracts, not anonymous Express handlers:

```js
import { defineRoute } from '../api/route-contracts.js';

export const listAccountKeys = defineRoute({
  method: 'GET',
  path: '/v1/account/keys',
  owner: 'identity-access-billing',
  surface: 'identity-access-billing',
  journey: 'account-api-keys',
  auth: { mode: 'account_session_or_api_key', scopes: ['keys:read'] },
  tenant_scope: { required: true, source: 'auth_context' },
  object_auth: { resource: 'api_key', action: 'list' },
  rate_limit: { class: 'account_read' },
  resource_limit: { class: 'small_json' },
  idempotency: { policy: 'none' },
  request_schema: null,
  response_schema: { $ref: '#/$defs/AccountKeysResponse' },
  errors: ['unauthorized', 'forbidden', 'rate_limited', 'server_error'],
  audit_event: null,
  openapi: { operationId: 'listAccountKeys', tags: ['Account'] },
  account_exposure: { pages: ['/account/api-keys'], states: ['loading', 'empty', 'success', 'error'] },
  cli_exposure: { commands: ['kolm keys list --json'] },
  sdk_exposure: { node: true, python: true, c: false, rust: false },
  handler: async (ctx) => {
    return ctx.ok({ keys: await ctx.services.keys.list(ctx.tenant.id) });
  },
});
```

CREATE `src/api/register-route.js` so Express registration is a thin adapter:

```js
export function registerRoute(router, contract) {
  assertRouteContract(contract);
  registerContract(contract);
  router[contract.method.toLowerCase()](contract.path, async (req, res) => {
    const ctx = await createRouteContext(req, res, contract);
    const auth = await authorizeRequest(ctx, contract);
    if (!auth.ok) return sendProblem(res, auth.problem);
    const idem = await applyIdempotency(ctx, contract);
    if (!idem.ok) return sendProblem(res, idem.problem);
    try {
      const result = await contract.handler(ctx);
      return sendEnvelope(res, contract, result);
    } catch (error) {
      return sendProblem(res, problemFromException(error, contract, ctx));
    }
  });
}
```

REPLACE the route scraping authority in `scripts/build-api-ref.cjs`. Scraping may stay as a temporary compatibility detector, but generated API docs must come from `getRouteContracts()`.

REPLACE `scripts/build-openapi.cjs` with an OpenAPI 3.1.2 emitter:

```js
for (const contract of getRouteContracts()) {
  op.security = securityFor(contract.auth);
  op.requestBody = requestBodyFor(contract.request_schema, contract.method);
  op.responses = responsesFor(contract.response_schema, contract.errors);
  op['x-kolm-surface'] = contract.surface;
  op['x-kolm-journey'] = contract.journey;
  op['x-kolm-tenant-scope'] = contract.tenant_scope;
  op['x-kolm-idempotency'] = contract.idempotency;
  op['x-kolm-account-exposure'] = contract.account_exposure;
  op['x-kolm-cli-exposure'] = contract.cli_exposure;
}
```

CODE: use JSON Schema 2020-12 for request/response schemas because OpenAPI 3.1 aligns with JSON Schema semantics. Store schemas under `src/api/schemas/*.js` and export `$defs` for shared Kolm envelope, problem, artifact, capture, tenant, billing, storage, eval, runtime, and account objects.

EXIT: `public/openapi.json` stops being a mostly path-level inventory and becomes a true client contract: operation security, payload schemas, known errors, idempotency, product ownership, and UI/CLI/SDK exposure are present for every route.

### API Docs And SDK Redlines

REDLINE: API docs are a generated page, but they are not yet the API authority.
ACTION: WIRE API docs to route contracts and DELETE stale manual snippets.
CODE: `public/docs/api.html` must render operation summary, auth, payload schema, response schema, problem responses, idempotency, rate/resource class, local-only/external-gated state, SDK examples, account link, CLI equivalent, and curl for every operation from a single generated source.
EXIT: fixing a route contract fixes API docs, OpenAPI, SDK examples, and account/API parity in one regeneration.

#### API Docs Replacement Blueprint

DELETE the pattern where API docs harvest nearby comments from route files as the product contract. Comments may appear as descriptions, but they cannot own behavior.

CREATE this generation flow:

```text
src/api/route-contracts.js
  -> docs/internal/api-contract-matrix.json
  -> public/docs/api-routes.json
  -> public/openapi.json
  -> public/docs/api.html
  -> SDK snippets and account route bindings
```

IMPLEMENT `scripts/build-api-contract-matrix.cjs` with these outputs per operation:

```json
{
  "method": "POST",
  "path": "/v1/distill/jobs",
  "operation_id": "createDistillJob",
  "surface": "distill-compile",
  "journey": "compile-task-model",
  "owner": "distillation-platform",
  "auth": {"mode": "account_session_or_api_key", "scopes": ["distill:write"]},
  "tenant_scope": {"required": true, "source": "auth_context"},
  "object_auth": {"resource": "distill_job", "action": "create"},
  "idempotency": {"policy": "requires_key", "ttl_seconds": 86400},
  "request_schema_ref": "#/$defs/CreateDistillJobRequest",
  "response_schema_ref": "#/$defs/DistillJobEnvelope",
  "problem_types": ["validation_failed", "unauthorized", "forbidden", "quota_exceeded", "provider_missing", "server_error"],
  "account_pages": ["/account/distill-runs"],
  "cli_commands": ["kolm distill run --json"],
  "docs_pages": ["/docs/cli/distill", "/quickstart"],
  "sdk_methods": ["client.distill.createJob"],
  "production_state": "implemented"
}
```

CODE: generated `public/docs/api.html` must show the exact request schema, success schema, problem types, idempotency behavior, auth/scopes, account page, CLI command, SDK method, and sample curl. The curl command must include only the headers and body the contract declares.

EXIT: finishing API docs means finishing the route contract. There is no separate manual API-doc task.

REDLINE: SDK examples can lie when package channels are source-only or unpublished.
ACTION: CREATE `docs/internal/sdk-release-matrix.json` and WIRE docs/API examples to it.
CODE: each SDK/package row must declare `published`, `source_preview`, `private_internal`, `deprecated_alias`, or `not_shipped`; examples must use only install commands that work for that state.
EXIT: docs never advertise an install command that cannot work.

REDLINE: docs still contain old package/repo identity in places.
ACTION: REPLACE hardcoded package names and repository URLs with generated values from `docs/internal/brand-package-identity.json`.
CODE: package install blocks, GitHub links, CloudFormation install paths, CLI hints, OpenGraph/schema URLs, docs cookbook prerequisites, and SDK import examples must consume one canonical identity module.
EXIT: old Kolmogorov names cannot re-enter public/docs/account/package surfaces unless explicitly marked historical.

#### Developer Ecosystem, SDK, And Integration Implementation Blueprint

REDLINE: SDK source exists in many languages, but there is no single API client contract that proves parity across Node, Python, C, Rust, TypeScript/browser, React Native, Swift, Kotlin, MCP, VS Code, LangChain, LlamaIndex, and runtime packages.
ACTION: CREATE `src/sdk/sdk-contract.js`, `docs/internal/sdk-capability-matrix.json`, `docs/internal/sdk-api-parity.json`, and `scripts/build-sdk-capability-matrix.cjs`; WIRE `sdk/`, `packages/`, API docs, OpenAPI, package release matrix, account developer pages, and CLI help to it.
CODE: every SDK row must declare package name, import path, release state, supported runtime, auth method, base URL config, timeout/retry policy, idempotency support, streaming support, error envelope support, typed methods, route coverage, artifact verify/load support, local-file support, browser/mobile constraints, examples, build/test/package commands, published artifact, and support tier.
EXIT: "SDK exists" is replaced by a per-language proof that users can install it, authenticate, call supported routes, handle errors, verify artifacts, and understand unsupported operations.

REDLINE: multiple package names currently compete for the same user mental model (`kolm`, `@kolm/kolm-sdk`, `@kolm/recipe-mcp`, `kolm-rn`, `kolm-attestation`, `@kolm/langchain`, `@kolm/llamaindex`, separate Python/Rust runtime packages).
ACTION: CREATE `docs/internal/package-name-authority.json` and REPLACE package docs/READMEs with names generated from it.
CODE: the authority must choose canonical package names for CLI, Node SDK, TypeScript/browser SDK, Python SDK, Rust API client, Rust artifact runtime, MCP server, VS Code extension, React Native SDK, Swift SDK, Kotlin SDK, LangChain adapter, LlamaIndex adapter, attestation package, Docker image, Helm chart, Homebrew, winget, apt, and browser extension. Each non-canonical alias must declare `deprecated_alias`, `private_internal`, or `source_preview` with migration and sunset date.
EXIT: a developer never sees two different install commands for the same product role.

REDLINE: generated API docs and SDK generation are blocked while OpenAPI is only a route inventory and the dialect target is unclear.
ACTION: CREATE `docs/internal/openapi-dialect-policy.json`, `scripts/build-openapi-client-fixtures.cjs`, and `tests/sdk-generated-client-smoke.test.js`; WIRE them to API contract generation.
CODE: choose the target dialect explicitly. The official latest OpenAPI version is `3.2.0`; if client tooling requires `3.1.2`, pin `3.1.2` with a documented compatibility reason. Do not leave `3.0.3`. The policy must include JSON Schema dialect, security scheme behavior, operationId naming, nullable/null modeling, file upload/download modeling, SSE/streaming modeling, webhook/callback modeling, error envelope schema, and `x-kolm-*` extensions.
EXIT: generated API clients can be produced and smoke-tested without reading `src/router.js`.

REDLINE: SDKs cannot be generated safely while route names, request schemas, response schemas, and errors are incomplete.
ACTION: CREATE `scripts/build-sdk-source.cjs`, `src/sdk/generate-client.js`, and `docs/internal/sdk-generation-manifest.json`.
CODE: generated clients must include typed request/response objects, typed problem errors, retry/idempotency helpers, streaming helpers, pagination helpers, file upload/download helpers, redaction-safe logging hooks, and examples. Handwritten SDK code may wrap generated clients, but it cannot redefine route payloads manually.
EXIT: API route changes update SDKs, docs, examples, and account developer snippets through the same build graph.

#### API Code Completion Execution Blueprint

REDLINE: the generated API inventory currently proves route breadth, not route finish. A scraped `public/docs/api-routes.json` with hundreds of routes and `stub: true` entries is not an API product; it is a list of promises.
ACTION: CREATE `docs/internal/api-completion-ledger.json` and `scripts/build-api-completion-ledger.cjs`; CLASSIFY every route as `production_contract`, `local_only`, `external_gated`, `internal_hidden`, `deprecated_alias`, `stub_blocker`, or `removed`.
CODE: no route may stay in `stub_blocker` without `owner`, `decision`, `replacement`, `customer_visible`, `docs_visible`, `account_visible`, `cli_visible`, `sdk_visible`, `required_schema`, `required_test`, and `ship_blocking` fields.
EXIT: the API docs and OpenAPI expose only finished public contracts, explicitly scoped local/external contracts, and intentional deprecated aliases. Stubs are not customer-visible.

REDLINE: `src/router.js` is doing too many jobs: route registry, business logic, product graph serving, billing, signup, gateway behavior, and generated docs source. That prevents atomic API completion.
ACTION: SPLIT route ownership into `src/routes/account.js`, `src/routes/auth.js`, `src/routes/billing.js`, `src/routes/capture.js`, `src/routes/compiler.js`, `src/routes/distill.js`, `src/routes/evals.js`, `src/routes/artifacts.js`, `src/routes/runtime.js`, `src/routes/marketplace.js`, `src/routes/enterprise.js`, `src/routes/product.js`, `src/routes/admin.js`, and `src/routes/system.js`.
CODE: each route file exports only route contracts and thin handlers. Shared services live under `src/services/*`; schema objects live under `src/api/schemas/*`; authorization lives under `src/security/*`; commercial rules live under `src/commercial/*`.
EXIT: `src/router.js` becomes composition only: create router, install middleware, register route contracts, install error handler, export app factory. No domain business logic remains there.

REDLINE: mutating routes are not finished until they are retry-safe, tenant-safe, and compensatable. `POST`, `PUT`, `PATCH`, and `DELETE` cannot rely on handler-local good intentions.
ACTION: ADD `src/api/idempotency.js`, `src/api/mutation-transaction.js`, and `src/api/side-effect-ledger.js`; REQUIRE every mutating route contract to declare `idempotency`, `side_effects`, `compensation`, `audit_event`, and `resource_lock`.
CODE: idempotency policies must be `requires_key`, `accepts_key`, `server_generated`, `non_retryable`, or `not_applicable`. Money-moving, artifact-publishing, delete/purge, deploy, SSO/SCIM, marketplace, and billing routes must never be `not_applicable`.
CODE: side effects must declare writes to local store, object storage, external provider, email, webhook, marketplace payout, Stripe, cloud deploy target, audit log, and background job queue.
EXIT: retrying a failed request cannot duplicate a billing action, deploy, artifact publish, marketplace sale, account deletion, training job, or email.

REDLINE: request validation and response validation are not optional polish. Without schemas, every SDK, API doc, account form, and integration example can drift.
ACTION: CREATE `src/api/schema-registry.js`, `src/api/validate-request.js`, `src/api/validate-response.js`, `src/api/schemas/envelope.js`, `src/api/schemas/problem.js`, `src/api/schemas/account.js`, `src/api/schemas/billing.js`, `src/api/schemas/capture.js`, `src/api/schemas/compiler.js`, `src/api/schemas/distill.js`, `src/api/schemas/eval.js`, `src/api/schemas/artifact.js`, `src/api/schemas/runtime.js`, and `src/api/schemas/marketplace.js`.
CODE: use JSON Schema 2020-12 semantics and emit compatible OpenAPI schema objects. Every schema must be named, versioned, reused through `$defs`, and covered by fixtures for valid input, invalid input, minimal response, maximal response, and problem response.
EXIT: route handlers cannot send shape-drifted JSON without failing local validation in development and contract tests in CI.

REDLINE: errors are currently a mix of envelopes, status codes, strings, and route-local details. Developer products need stable, typed failure modes.
ACTION: CREATE `src/api/problems.js` and `docs/internal/problem-type-registry.json`; MAKE every route return a stable problem object inside the Kolm envelope and map it to RFC 9457-compatible fields for OpenAPI.
CODE: every problem type must define `type`, `title`, `status`, `code`, `safe_detail`, `retryable`, `user_action`, `operator_action`, `docs_url`, `support_context_fields`, and `redaction_policy`.
CODE: base problem types must include `validation_failed`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `quota_exceeded`, `usage_limit_exceeded`, `billing_required`, `payment_required`, `external_provider_missing`, `external_provider_failed`, `object_storage_missing`, `cloud_not_configured`, `artifact_invalid`, `signature_invalid`, `schema_mismatch`, `idempotency_conflict`, `job_not_ready`, and `server_error`.
EXIT: API docs, SDK errors, account errors, CLI errors, and support logs all use the same problem type registry.

REDLINE: OpenAPI 3.0.3 is not an acceptable final target for this product surface when the product depends on JSON Schema fidelity, nullable values, webhooks, callbacks, streaming, and generated SDKs.
ACTION: IMPLEMENT `scripts/build-openapi.cjs` as a contract emitter, not a route inventory merger; PIN dialect in `docs/internal/openapi-dialect-policy.json`.
CODE: if target is latest, emit OpenAPI `3.2.0`; if ecosystem tooling requires stability, emit `3.1.2` plus a compatibility note. Do not ship `3.0.3` as final. Include `jsonSchemaDialect`, security schemes, servers, tags, request bodies, response schemas, examples, callbacks/webhooks where applicable, and `x-kolm-*` implementation extensions.
EXIT: `public/openapi.json` can generate SDK clients and API reference without opening `src/router.js` or scraping comments.

REDLINE: examples are not finished if they are written by hand. Every curl, Node, Python, CLI, and SDK snippet can rot.
ACTION: CREATE `examples/api-fixtures/*`, `scripts/build-api-examples.cjs`, and `tests/api-example-fixtures.test.js`; GENERATE docs examples from executable fixtures.
CODE: every public operation must have at least one fixture class: `happy_path`, `auth_failure`, `validation_failure`, `quota_or_billing_failure`, and `external_dependency_missing` where applicable. Fixture output becomes the example response in API docs.
EXIT: API docs cannot show a request or response that does not execute against local route handlers or declared mock providers.

REDLINE: route auth cannot be inferred from path prefix. `/v1/product/*`, `/v1/storage/*`, `/v1/account/*`, `/v1/billing/*`, `/v1/artifacts/*`, and `/v1/admin/*` need explicit auth, scope, tenant, and object authorization in the contract.
ACTION: ADD auth metadata to every route contract and generate an auth matrix at `docs/internal/api-auth-matrix.json`.
CODE: each route declares `auth_mode`, `scopes`, `tenant_required`, `tenant_source`, `resource_type`, `resource_id_source`, `object_action`, `admin_role`, `break_glass_allowed`, `local_dev_allowed`, and `anonymous_allowed`.
EXIT: a route cannot be registered unless auth behavior is explicit and account/API docs show it.

REDLINE: API pagination, filtering, and sorting cannot vary by endpoint. Inconsistent list semantics break SDKs and account tables.
ACTION: CREATE `src/api/list-contract.js` and require all list routes to use it.
CODE: list contracts must declare `cursor`, `limit`, `order`, `filters`, `sort_keys`, `default_sort`, `max_limit`, `snapshot_behavior`, `tenant_fence`, and `pagination_response`.
EXIT: every table in account UI, every list route in API docs, and every SDK list method uses the same pagination contract.

REDLINE: streaming and long-running jobs are first-class for capture, distillation, evals, deploys, and runtime. Treating them as ordinary JSON routes hides cancellation, progress, retry, and partial failure semantics.
ACTION: CREATE `src/api/job-contract.js`, `src/api/stream-contract.js`, `src/jobs/job-store.js`, and `docs/internal/job-lifecycle-contract.json`.
CODE: job states must include `queued`, `scheduled`, `running`, `waiting_external`, `cancel_requested`, `canceling`, `succeeded`, `failed`, `timed_out`, `rolled_back`, and `expired`. Each state declares allowed transitions, event type, account rendering, CLI output, SDK method, and retry behavior.
CODE: stream contracts must declare media type, event names, heartbeat, reconnect behavior, terminal event, auth lifetime, backpressure behavior, max duration, and fallback poll route.
EXIT: distill, eval, deploy, capture replay, and runtime jobs have one lifecycle across API/account/CLI/SDK.

REDLINE: generated API docs must not be the only consumer of contracts. The product graph, account matrix, CLI help, SDKs, QA shots, and release gates must all depend on the same route contract.
ACTION: MAKE `scripts/build-api-contract-matrix.cjs` the upstream dependency for product graph, API docs, OpenAPI, SDK generation, account route binding, CLI help snippets, and release verification.
CODE: stale generated artifacts fail with file path, expected hash, actual hash, and regeneration command. Generation order must be deterministic and serial where outputs depend on each other.
EXIT: the API cannot drift in five places again because there is only one contract graph.

REDLINE: docs quickstarts are broad but not shaped around the three product jobs customers actually need to complete.
ACTION: CREATE `docs/internal/developer-golden-paths.json`, `scripts/build-developer-quickstarts.cjs`, and `public/docs/start/*`.
CODE: ship exactly three primary developer paths before the full command encyclopedia: `route-model-traffic`, `compile-distill-artifact`, and `run-govern-anywhere`. Each path must include one copy-paste command, one API example, one SDK example, one account UI handoff, one expected output, one common failure, one cost/readiness note, and one next action. Secondary pages can remain exhaustive, but first-run docs must be outcome-first.
EXIT: a new developer can complete each of the three product surfaces without navigating the whole docs tree.

REDLINE: MCP support exists as source, but MCP is a security-sensitive integration surface and cannot be treated as a generic local helper.
ACTION: CREATE `src/integrations/mcp-contract.js`, `docs/internal/mcp-tool-contract.json`, and `tests/mcp-security-contract.test.js`; WIRE `sdk/mcp/server.mjs`, `services/mcp/server.js`, `kolm serve --mcp`, docs, account integrations, and package release state.
CODE: every MCP tool/resource/prompt must declare name, description, input schema, output schema, auth requirement, tenant scope, artifact scope, rate/resource limit, tool-call audit event, prompt/data boundary, secret redaction, disabled state, and safe error. Support both stdio and streamable HTTP only when the transport contract proves auth and origin behavior.
EXIT: MCP tools can be used by Claude Code, Cursor, Continue, and other agent clients without silent cross-tenant access, prompt leakage, or unsupported tool promises.

REDLINE: VS Code extensions are split across `sdk/vscode` and `packages/vscode-kolm-rag`, with overlapping product promises and unclear publication state.
ACTION: CREATE `docs/internal/vscode-extension-contract.json`, `scripts/build-vscode-extension-matrix.cjs`, and `tests/vscode-extension-manifest-contract.test.js`; WIRE both extension manifests, docs, package release matrix, account developer pages, and product graph.
CODE: the contract must decide whether there is one extension or multiple editions. Each extension declares publisher, extension id, display name, activation events, commands, configuration keys, telemetry events, local secret storage policy, workspace trust behavior, status-bar UX, capture permissions, package command, marketplace state, pre-release state, and Open VSX/Marketplace publication path.
EXIT: editor integration becomes an installable product with clear commands and privacy behavior, not two overlapping manifests.

REDLINE: ecosystem loader folders under `tools/` are valuable but still draft scaffolds, so the product cannot imply native adoption by llama.cpp, Ollama, Hugging Face Hub, vLLM, or LM Studio.
ACTION: CREATE `docs/internal/ecosystem-loader-matrix.json`, `src/integrations/ecosystem-loader-contract.js`, and `scripts/build-ecosystem-loader-matrix.cjs`; WIRE `tools/hf-hub-kolm`, `tools/llama-cpp-kolm-loader`, `tools/ollama-kolm`, `tools/vllm-kolm`, `tools/lm-studio-kolm`, docs, runtime matrix, and readiness closeout.
CODE: every loader row must declare host project, integration type, status (`draft`, `local_plugin`, `submitted_upstream`, `accepted_upstream`, `published_package`, `blocked`), install command, compatibility version, supported artifact subset, signature verification behavior, model-card/metadata fields, failure mode, upstream issue/PR URL, tests, and owner. Draft scaffolds must be hidden from public "native support" claims.
EXIT: ecosystem adoption is visible, honest, and buildable, with a concrete path from local plugin to upstream-native support.

REDLINE: import/export apps support GGUF, ONNX, safetensors, Core ML, ExecuTorch, MLX, TensorRT, model cards, SBOM, and AI Act docs, but the developer workflow is not a single reversible artifact lifecycle.
ACTION: CREATE `src/integrations/artifact-io-contract.js`, `docs/internal/artifact-import-export-matrix.json`, and `scripts/build-artifact-io-matrix.cjs`; WIRE `apps/import/*`, `apps/export/*`, runtime compatibility, account artifact pages, CLI import/export, and docs.
CODE: every import/export target declares file extensions, MIME types, input validation, output validation, signature behavior, dependency/toolchain version, license/provenance requirements, metadata mapping, model-card mapping, quantization support, eval preservation, rollback artifact, smoke command, and unsupported artifact classes.
EXIT: Kolm can import/export artifacts without losing provenance, eval scope, signature trust, or runtime compatibility.

REDLINE: integration docs for LangChain, LlamaIndex, Zapier, Make, cloud AI services, edge workers, Helm, and GitHub Actions can become marketing pages unless each one has a runnable contract.
ACTION: CREATE `docs/internal/integration-contract-matrix.json`, `scripts/build-integration-contracts.cjs`, and `tests/integration-doc-snippet-contract.test.js`; WIRE `public/docs/integrations/*`, `packages/*-kolm`, `tools/*`, examples, and package release matrix.
CODE: every integration page must declare install state, auth state, minimum compatible upstream version, runnable sample, expected output, secret handling, tenant scope, supported product surface, unsupported features, local smoke command, and package/channel status. Snippets must be executed or generated from fixture code.
EXIT: integration pages stop being claims and become executable implementation contracts.

REDLINE: developer/account onboarding does not yet expose package/API/SDK readiness as a product surface.
ACTION: CREATE `public/account/developers.html`, `public/account/integrations.html`, and `public/account/sdk-status.html`; WIRE account shell, package release matrix, SDK parity matrix, OpenAPI route contracts, integration contracts, and copy buttons.
CODE: developer account pages must show API key state, base URL, OpenAPI version, SDK install commands by release state, route coverage, package publish state, MCP/editor integration state, cloud/runtime credentials, local smoke commands, copy buttons with visible success/error states, and disabled reasons. Use dense operational layout, stable cards/tables, keyboardable controls, no hover-only affordances, and typed error envelopes.
EXIT: the post-auth product tells developers exactly what they can install and run today.

### Account And Post-Auth Product Redlines

REDLINE: account pages exist but do not all behave like product surfaces.
ACTION: CREATE `public/account/account-shell.js`, `public/account/account-state.js`, `public/account/account-actions.js`, and `scripts/build-account-product-matrix.cjs`; REPLACE per-page shell/nav/state fragments.
CODE: each account page declares `journey`, `surface`, `primary_resource`, `api_routes`, `required_auth`, `required_plan`, `empty_state`, `loading_state`, `error_state`, `partial_state`, `missing_credential_state`, `local_only_state`, `external_gated_state`, `success_state`, and `primary_action`.
EXIT: every post-auth page has live or explicitly scoped state, not just rendered HTML.

REDLINE: account buttons and controls can be decorative or ownerless.
ACTION: WIRE every button/form/filter/table action to `docs/internal/account-interaction-contract.json`.
CODE: controls must declare command id, accessible label, keyboard behavior, disabled/loading/success/error states, API/CLI action, confirmation policy, undo/rollback policy, and telemetry event.
EXIT: no account control exists without a real action contract or an explicit disabled/reference state.

REDLINE: account shell/nav/focus/metadata drift appears repeatedly.
ACTION: REPLACE duplicate skip links, page-local nav, mojibake titles, inline shell styles, and old GitHub links with generated shell output.
CODE: one shell generator owns title, description, H1, top nav, side nav, breadcrumbs, current-page state, skip link, focus ring tokens, account theme, and footer links.
EXIT: account pages feel like one product, not a pile of stitched pages.

#### Enterprise Identity, Tenant, And Authorization Blueprint

REDLINE: `src/auth.js` resolves tenant keys, `src/teams.js` owns role ranks, and routes perform mixed authorization checks, but there is no single principal/tenant/team/resource authorization authority.
ACTION: CREATE `src/security/principal.js`, `src/security/tenant-context.js`, `src/security/authorization-model.js`, `src/security/policy-decision.js`, and `docs/internal/authorization-model.json`; WIRE `authMiddleware`, team routes, account routes, API keys, SSO, SCIM, service keys, and route contracts to them.
CODE: every request must produce one `Principal`:

```json
{
  "actor_id": "tenant_or_user_or_service",
  "actor_type": "account_user|api_key|service_key|admin|anonymous|agent",
  "auth_method": "session_cookie|bearer_api_key|x_api_key|sso|scim_token|admin_key|local_fixture",
  "tenant_id": "tenant_...",
  "workspace_id": "team_...",
  "roles": ["owner|admin|member|viewer|billing|security|auditor|developer|operator"],
  "scopes": ["capture:read", "distill:write"],
  "plan": "free|pro|team|enterprise",
  "country_code": "US",
  "sso_subject": null,
  "api_key_id": null,
  "session_id": null,
  "is_break_glass": false
}
```

CODE: authorization checks must use resource-first decisions:

```js
can(principal, {
  action: 'artifact.publish',
  resource: { type: 'artifact', id: 'art_...', tenant_id, team_id },
  context: { route, method, plan, region, data_class, risk_tier }
});
```

The decision result must include `allow`, `reason`, `required_role`, `required_scope`, `required_plan`, `resource_owner`, `decision_id`, `event_fields`, and `safe_user_message`.

EXIT: routes do not hand-roll role checks; object-level and function-level authorization use one policy engine.

REDLINE: team/workspace permissions are role-based but not expressive enough for nested resources, agents, service keys, captures, artifacts, datasets, deployments, and governed tools.
ACTION: IMPLEMENT a relationship model inspired by OpenFGA-style tuples without making Kolm dependent on an external PDP.
CODE: `docs/internal/authorization-model.json` must define resource types and relations:

```json
{
  "types": {
    "tenant": {"relations": ["owner", "admin", "member", "viewer"]},
    "team": {"relations": ["owner", "admin", "member", "viewer", "billing", "security", "auditor"]},
    "artifact": {"relations": ["owner", "publisher", "runner", "viewer"]},
    "capture": {"relations": ["owner", "labeler", "viewer"]},
    "dataset": {"relations": ["owner", "trainer", "viewer"]},
    "distill_job": {"relations": ["owner", "operator", "viewer"]},
    "deployment": {"relations": ["owner", "operator", "approver", "viewer"]},
    "storage_object": {"relations": ["owner", "reader", "writer"]},
    "agent_tool": {"relations": ["owner", "invoker", "approver"]}
  }
}
```

CODE: persist relationship tuples as first-class records with actor, relation, object, tenant, grant source, expiry, created_by, and revocation state. Use them for account UI permissions, agent/tool authorization, API keys, and route contracts.

EXIT: authorization can answer "who can do what to this exact object" without route-specific code.

REDLINE: API key lifecycle is still too close to tenant identity.
ACTION: CREATE `src/security/api-key-lifecycle.js` and `docs/internal/api-key-lifecycle-matrix.json`; REPLACE one-key-per-tenant assumptions.
CODE: API keys must be separate records with id, prefix, hash, tenant, team, actor, scopes, plan entitlement, status (`active|rotated|revoked|expired|compromised|pending`), created_at, last_used_at, rotated_from, expires_at, allowed_origins, allowed_ips, and display name. Raw keys are returned only once.
EXIT: users can rotate, scope, revoke, and inspect keys without rotating the whole tenant identity.

REDLINE: Enterprise SSO/SCIM/SAML cannot be just public metadata endpoints.
ACTION: CREATE `src/enterprise/sso-config.js`, `src/enterprise/scim-directory.js`, `src/enterprise/group-mapping.js`, and `docs/internal/enterprise-identity-matrix.json`.
CODE: implement SAML metadata/config state, IdP certificate rotation, ACS URL, entity ID, group-to-role mapping, SCIM Users, SCIM Groups, deprovisioning, soft-delete, reactivation, externalId mapping, service-provider config, token rotation, and customer-visible setup states.
EXIT: Enterprise identity setup supports no-config, metadata-ready, configured, test-passed, active, certificate-expiring, token-expired, deprovisioned, and error states in API/account/docs.

#### Billing, Entitlement, And Customer Lifecycle Blueprint

REDLINE: plan checks, pricing, Stripe state, usage, invoices, Enterprise sales review, and account access are not one lifecycle.
ACTION: CREATE `src/billing/billing-state-machine.js`, `src/billing/stripe-event-inbox.js`, `src/billing/entitlements.js`, `src/billing/usage-meter.js`, `src/billing/reconciliation.js`, and `docs/internal/billing-lifecycle-matrix.json`; WIRE pricing, `/v1/plans`, `/v1/billing/tiers`, account billing pages, route plan gates, CLI billing, and docs to this state machine.
CODE: billing state must include `free`, `trialing`, `active`, `incomplete`, `incomplete_expired`, `past_due`, `unpaid`, `paused`, `canceled`, `enterprise_sales_review`, `enterprise_contracting`, `legacy_migration`, and `manual_override`.

CODE: Stripe webhooks must be ingested into an event inbox by event id, signature verification status, received_at, processing_status, replay_count, linked customer/subscription/invoice/payment_intent, and last_error. Business logic runs after durable ingest and can be replayed.

CODE: entitlement decisions must be independent from display plan labels:

```js
entitlementsFor({ plan, billing_status, seats, usage, sales_required, override });
canUseFeature(principal, 'distill.create_job');
```

EXIT: payment failure, late webhook, plan change, Enterprise sales routing, cancellation, invoice retry, and legacy plan mapping cannot silently desync access from billing truth.

REDLINE: usage-based product economics are not complete until model/API spend, saved cost, compile cost, and account chargeback use one meter.
ACTION: CREATE `src/billing/usage-ledger.js`, `src/billing/cost-attribution.js`, and `docs/internal/usage-metering-contract.json`.
CODE: every billable or savings-bearing action records tenant, team, actor, route, provider, model, artifact, tokens, bytes, runtime seconds, storage bytes, worker class, cost estimate, cost source, savings estimate, idempotency key, and evidence id.
EXIT: ROI calculator, account chargeback, pricing enforcement, Enterprise reports, and product telemetry use the same usage ledger.

#### Commercial Systems, Pricing, Entitlements, And Enterprise Revenue Blueprint

REDLINE: the commercial system is not one product surface. Current code has Stripe signature helpers in `src/stripe.js`, upgrade fallback in `src/billing-upgrade.js`, static meters in `src/usage.js`, event-store cost breakdown in `src/billing-breakdown.js`, chargeback in `src/chargeback.js`, forecast-only marketplace payouts in `src/marketplace-payouts.js`, and visible pricing/account pages that do not all share the same plan and meter vocabulary.
ACTION: CREATE `src/commercial/pricing-catalog.js`, `src/commercial/plan-aliases.js`, `src/commercial/entitlement-engine.js`, `src/commercial/subscription-state.js`, `src/commercial/stripe-webhook-inbox.js`, `src/commercial/usage-ledger.js`, `src/commercial/roi-evidence.js`, `src/commercial/enterprise-intake.js`, `src/commercial/procurement-workflow.js`, `src/commercial/marketplace-monetization.js`, `src/commercial/tax-policy.js`, `src/commercial/invoice-ledger.js`, `public/account/billing-state.js`, `public/account/usage-breakdown.js`, `public/account/roi-report.js`, `docs/internal/commercial-contract.json`, and `scripts/build-commercial-contract.cjs`.
CODE: the commercial contract must become the single writer for `/v1/plans`, `/v1/billing/tiers`, `/v1/billing/usage`, `/v1/billing/breakdown`, `/v1/chargeback`, `/v1/savings/summary`, `/v1/enterprise/inquiry`, `/v1/marketplace/payouts`, `public/pricing.html`, `public/roi.html`, `public/enterprise.html`, `public/account/billing.html`, CLI billing commands, generated OpenAPI, and API docs.
EXIT: no plan name, price, feature gate, usage meter, invoice state, Enterprise CTA, savings claim, marketplace fee, or billing status is duplicated outside the generated commercial contract.

REDLINE: plan names are fractured. The worktree still contains Free/Pro/Team/Business/Enterprise visible pricing while backend helpers map legacy `starter`, `business`, `team`, and `teams` differently. That makes billing, account UX, docs, and sales contracts impossible to reason about.
ACTION: IMPLEMENT `src/commercial/pricing-catalog.js` as a versioned catalog with only canonical plan ids `free`, `pro`, `team`, and `enterprise`; MOVE legacy aliases into `src/commercial/plan-aliases.js`; MAKE every legacy id resolve to `{canonical_plan, legacy_plan, migration_reason, effective_at, expires_at}` instead of silently passing through.
CODE: each catalog row must declare `id`, `display_name`, `price_usd_month`, `price_usd_year`, `sales_required`, `self_serve_allowed`, `stripe_price_env`, `stripe_payment_link_env`, `max_seats`, `included_usage`, `overage_policy`, `support_sla`, `security_features`, `deployment_features`, `runtime_features`, `distillation_features`, `gateway_features`, `artifact_features`, `marketplace_features`, `docs_url`, and `account_upgrade_url`.
CODE: `business` must not appear as a sellable public plan. It may exist only as a legacy alias resolving to `enterprise` or `team` with a deterministic migration date and account-visible migration banner.
EXIT: `rg -n "Business|Starter|Developer free|1499|2999|indie|teams" public docs src cli tests` returns only intentional legacy alias fixtures, migration tests, or changelog entries.

REDLINE: entitlement checks cannot be route-local if Kolm sells three product surfaces: route/capture model traffic, compile/distill task artifacts, and run/govern artifacts on devices. A user must never see a button that the backend later rejects for a different reason.
ACTION: BUILD `src/commercial/entitlement-engine.js` around a closed feature vocabulary and REQUIRE every route, CLI command, account action, and public CTA to ask `canUse({tenant, actor, feature, action, resource})`.
CODE: feature keys must include `gateway.capture`, `gateway.provider_routing`, `gateway.privacy_redaction`, `gateway.cost_optimization`, `compiler.compile`, `compiler.distill`, `compiler.teacher_council`, `compiler.eval`, `compiler.k_score`, `runtime.device_deploy`, `runtime.edge_deploy`, `runtime.cloud_deploy`, `runtime.registry_private`, `governance.sso`, `governance.scim`, `governance.audit_export`, `billing.chargeback`, `marketplace.publish`, `marketplace.install`, and `support.enterprise_review`.
CODE: denial reasons must be closed and surfaced unchanged across API/account/CLI: `no_auth`, `tenant_missing`, `plan_required`, `feature_not_in_plan`, `seat_limit`, `usage_limit`, `invoice_past_due`, `subscription_unpaid`, `trial_expired`, `sales_review_required`, `enterprise_contracting`, `external_gate_unmet`, `compliance_hold`, `resource_not_owned`, and `admin_required`.
EXIT: clicking any account action produces either the successful operation or the exact entitlement denial reason with the exact upgrade/procurement/sales next action; no generic `forbidden` or `upgrade required` dead ends remain.

REDLINE: Stripe is currently a helper, not a revenue state machine. Signature verification and Checkout creation exist, but there is no durable event inbox, no replay contract, no canonical subscription transition table, no customer portal state, and no guarantee that access is provisioned from active entitlements instead of stale local plan text.
ACTION: IMPLEMENT `src/commercial/stripe-webhook-inbox.js` with raw body storage, signature status, event id uniqueness, received timestamp, processed timestamp, retry count, terminal status, and replay command; IMPLEMENT `src/commercial/subscription-state.js` as the only mapper from Stripe events into local account state.
CODE: subscription states must include `checkout_created`, `checkout_completed`, `trialing`, `active`, `incomplete`, `incomplete_expired`, `past_due`, `unpaid`, `paused`, `canceled`, `payment_action_required`, `payment_method_required`, `invoice_open`, `invoice_paid`, `invoice_void`, `customer_portal_opened`, `enterprise_sales_review`, `enterprise_contracting`, `marketplace_entitled`, `legacy_migration`, and `manual_override`.
CODE: handled Stripe event types must include `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.created`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `payment_method.attached`, and `entitlements.active_entitlement_summary.updated`.
CODE: outbound Stripe POSTs must use deterministic idempotency keys derived from tenant id, action id, target plan, billing period, and request nonce; idempotency keys must exclude email, name, API key, and any personal identifier.
EXIT: payment retries, duplicate webhooks, expired checkout sessions, failed 3DS, unpaid invoices, customer portal changes, and entitlement updates all converge on the same local subscription state without double-provisioning or double-charging.

REDLINE: usage counters and cost breakdown are not one ledger. `src/usage.js` meters billable units, `src/billing-breakdown.js` reads event-store costs, account billing displays a different twelve-meter vocabulary, and ROI/savings uses separate assumptions.
ACTION: REPLACE the split with `src/commercial/usage-ledger.js` and `src/commercial/cost-and-savings-ledger.js`; KEEP compatibility wrappers in `src/usage.js`, `src/billing-breakdown.js`, and `src/chargeback.js` until routes migrate.
CODE: every billable or commercial metric row must store `ledger_id`, `tenant_id`, `actor_id`, `namespace`, `project`, `department`, `surface`, `feature`, `action`, `resource_id`, `provider`, `model`, `region`, `unit`, `quantity`, `unit_price_micro_usd`, `cost_micro_usd`, `savings_micro_usd`, `currency`, `pricing_snapshot_id`, `source_event_id`, `idempotency_key`, `recorded_at`, and `reconciled_at`.
CODE: allowed units must cover `model_tokens_in`, `model_tokens_out`, `captured_calls`, `redacted_calls`, `stored_events`, `artifact_builds`, `distillation_jobs`, `teacher_gpu_minutes`, `worker_cpu_seconds`, `worker_gpu_seconds`, `object_storage_bytes`, `egress_bytes`, `registry_artifacts`, `artifact_installs`, `device_targets`, `team_seats`, `audit_exports`, `marketplace_revenue`, `marketplace_platform_fee`, and `enterprise_sync_bytes`.
EXIT: account billing, chargeback, ROI, usage caps, Enterprise reports, marketplace revenue, benchmark cost evidence, and billing invoices all read from the same immutable ledger rows.

REDLINE: ROI cannot stay a marketing calculator. For an AI cost product, ROI must be a reproducible evidence artifact tied to account traffic, provider price snapshots, benchmark method, and confidence interval.
ACTION: IMPLEMENT `src/commercial/roi-evidence.js`, `docs/internal/roi-methodology.json`, `public/roi-calculator.js`, and `public/account/roi-report.js`; WIRE public ROI, account ROI, sales reports, and shareable ROI links to the same calculation function.
CODE: ROI inputs must include current monthly spend, provider mix, model mix, traffic volume, prompt/completion ratio, latency target, quality target, data-retention constraints, local-device target, artifact build cost, hosted runtime cost, storage cost, labor assumption, and sales-cycle confidence level.
CODE: ROI outputs must include baseline cost, Kolm gateway cost, Kolm compile/distill cost, runtime cost, storage cost, gross savings, platform fee, net savings, payback period, quality risk, latency risk, data confidence, pricing snapshot date, and methodology version.
CODE: public ROI may use user-entered estimates; account ROI must use ledger-backed observed traffic when available; sales ROI must attach a frozen JSON evidence packet and never claim savings without source rows.
EXIT: every ROI number on the site can be opened as JSON with inputs, assumptions, pricing snapshot, formula version, and confidence notes.

REDLINE: Enterprise sales is not a contact form. It is a stateful procurement lifecycle that must join plan gating, security evidence, legal docs, cloud architecture, support SLA, PO/invoice flow, and admin activation.
ACTION: CREATE `src/commercial/enterprise-intake.js`, `src/commercial/procurement-workflow.js`, `docs/internal/enterprise-sales-lifecycle.json`, `public/enterprise/inquiry.html`, `public/account/procurement.html`, and `/v1/enterprise/inquiry`, `/v1/enterprise/procurement`, `/v1/enterprise/security-packet`, `/v1/enterprise/architecture-review`, `/v1/enterprise/contract-status`.
CODE: enterprise states must include `anonymous_interest`, `contact_captured`, `qualified`, `technical_discovery`, `architecture_review`, `security_review`, `legal_review`, `dpa_review`, `baa_review`, `procurement_review`, `po_requested`, `invoice_requested`, `contract_sent`, `contract_signed`, `implementation_scheduled`, `active`, `blocked`, `closed_lost`, and `renewal`.
CODE: every state must own required fields, next actor, SLA clock, required evidence packet, allowed account features, allowed sales actions, customer-visible label, and fallback contact.
EXIT: Enterprise CTAs never point to fake self-serve checkout; they create or resume a procurement object with visible status and next action.

REDLINE: marketplace payouts are currently labelled forecast-only. That is honest, but it means marketplace cannot be marketed as a finished seller revenue platform.
ACTION: IMPLEMENT `src/commercial/marketplace-monetization.js` as the bridge between artifact installs, seller accounts, fee schedule, tax status, refund/dispute state, payout provider, and ledger rows; KEEP `src/marketplace-payouts.js` as a compatibility wrapper until fully migrated.
CODE: marketplace monetization must model `seller_onboarding_required`, `seller_pending_tax_info`, `seller_active`, `listing_free`, `listing_paid`, `install_recorded`, `refund_requested`, `refund_approved`, `refund_denied`, `dispute_open`, `dispute_won`, `dispute_lost`, `payout_forecast`, `payout_scheduled`, `payout_dispatched`, `payout_failed`, and `payout_reconciled`.
CODE: fee schedules must be versioned and attached to every listing sale as immutable `fee_schedule_id`; changing a platform share must not alter historical payouts.
EXIT: marketplace pages, account publisher dashboard, payout exports, tax status, and API docs distinguish forecast payouts from dispatched payouts without hidden text or implementation gaps.

REDLINE: tax and invoicing cannot be afterthoughts once Kolm sells internationally, through Enterprise procurement, and through marketplaces. Plan prices without tax, billing address, exemption, invoice, credit note, and refund state are not finished commercial code.
ACTION: CREATE `src/commercial/tax-policy.js`, `src/commercial/invoice-ledger.js`, `docs/internal/tax-and-invoice-contract.json`, `/v1/billing/invoices`, `/v1/billing/tax-status`, and `/v1/billing/customer-portal`.
CODE: tax policy must store `country`, `region`, `currency`, `billing_address_status`, `tax_id_status`, `tax_exemption_status`, `tax_registration_status`, `product_tax_code`, `reverse_charge_status`, `marketplace_tax_liability`, and `last_calculated_at`.
CODE: invoice ledger must store invoice id, customer id, subscription id, period, line items, discounts, credits, tax amounts, subtotal, total, paid amount, currency, payment status, collection method, PDF URL, hosted invoice URL, refund links, and account-visible failure reason.
EXIT: account billing can answer "what am I paying for", "what is taxable", "what failed", "what changed", "what can I download", and "what do I do next" from first-party state.

REDLINE: account billing UX must stop being a meter table bolted onto the account. It must be an operating console for plan, entitlement, invoices, spend, savings, procurement, chargeback, and marketplace revenue.
ACTION: BUILD `public/account/billing-state.js`, `public/account/usage-breakdown.js`, `public/account/entitlements-panel.js`, `public/account/invoices-panel.js`, `public/account/procurement-panel.js`, `public/account/marketplace-revenue-panel.js`, and `public/account/roi-report.js` on top of the commercial API contract.
CODE: the first viewport must show `plan`, `subscription_state`, `next_billing_date`, `monthly_commit`, `current_spend`, `net_savings`, `usage_risk`, `payment_status`, `invoice_status`, `enterprise_status`, and `primary_next_action`.
CODE: every destructive or money-moving action must have a preview response before commit: plan change preview, downgrade impact preview, cancel impact preview, seat-limit impact preview, marketplace payout preview, refund preview, and tax/address impact preview.
EXIT: account billing works for Free, Pro, Team, Enterprise sales review, Enterprise active, legacy migration, unpaid, past due, canceled, and marketplace seller tenants without blank tables or hidden instructions.

REDLINE: commercial telemetry is not product analytics unless it is tied to activation and revenue decisions. Page views alone do not tell Kolm whether users reached owned AI.
ACTION: IMPLEMENT `src/commercial/commercial-telemetry.js` and `docs/internal/revenue-metrics-contract.json`; CAPTURE activation, conversion, and retention events into the same event-store with privacy-safe attributes.
CODE: tracked revenue metrics must include visit-to-signup, signup-to-api-key, api-key-to-first-capture, first-capture-to-first-artifact, first-artifact-to-first-device-run, first-device-run-to-team-invite, team-invite-to-paid, paid-to-retained, enterprise-inquiry-to-qualified, qualified-to-contract, contract-to-active, and marketplace-install-to-repeat-install.
CODE: each event must include tenant id or anonymous session id, surface, source route, intent, feature, plan at time, entitlement state, experiment id, and no secret values.
EXIT: product, sales, pricing, ROI, and docs decisions are backed by one privacy-safe activation funnel instead of guesses from static pages.

REDLINE: the commercial surface must respect current platform realities, not invent private behavior. Subscription access must follow provider lifecycle states; entitlement changes must be provisioned and revoked from active entitlement events; marketplace buyers must be resolved and rechecked against marketplace entitlement APIs; tax must be calculated from billing context, not hard-coded copy.
ACTION: ENCODE third-party dependency assumptions in `docs/internal/commercial-platform-dependencies.json` with source URL, behavior relied on, local module, failure mode, and fallback; GENERATE a public-scoped note for docs where customer action is required.
CODE: Stripe dependency rows must cover subscription status transitions, incomplete checkout expiration, invoice paid/payment failed events, active entitlement summary updates, customer portal session behavior, idempotency keys, automatic tax, and Checkout automatic tax settings.
CODE: AWS Marketplace dependency rows must cover customer token resolution, entitlement lookup, contract/license persistence, entitlement update events, concurrent agreements, and post-launch continued response requirements.
EXIT: commercial code never assumes "paid means active" without reconciling subscription, invoice, entitlement, and local provisioning state.

#### Data Lifecycle, Privacy, And Retention Blueprint

REDLINE: local data, observations, captures, labels, artifacts, teams, keys, events, exports, and temp backups exist without one data-class authority.
ACTION: CREATE `src/data/data-classification.js`, `src/data/lifecycle-policy.js`, `src/data/export-workflow.js`, `src/data/delete-workflow.js`, `src/data/legal-hold.js`, and `docs/internal/data-inventory.json`; WIRE `src/store.js`, `src/event-store.js`, `src/audit-retention.js`, `src/audit-export.js`, `src/data-residency.js`, account privacy pages, and destructive routes to it.
CODE: every data class must declare owner, sensitivity, tenant scope, storage location, retention, backup policy, exportability, deletion behavior, legal-hold behavior, residency, encryption requirement, redaction requirement, and release inclusion.

CODE: user/customer rights flows must be state machines:

```json
{
  "request_id": "dsr_...",
  "type": "access|export|delete|portability|rectification|retention_override",
  "subject": {"tenant_id": "...", "email": "..."},
  "state": "received|verifying_identity|collecting|redacting|ready|delivered|deleted|blocked_by_legal_hold|failed",
  "data_classes": ["captures", "artifacts", "audit_events"],
  "deadline_at": "...",
  "evidence": []
}
```

EXIT: export/delete/purge/account deletion/data residency are product workflows, not one-off route handlers.

REDLINE: unmanaged temp/backup files can keep reappearing in `data/`.
ACTION: REPLACE ad hoc `.tmp` and `.bak` behavior with `src/data/managed-backups.js` and source-boundary rules.
CODE: writes to observation/capture/lake files must use atomic write helpers that place temp files under an ignored managed temp directory, clean on success, and record failed recovery files with expiry and owner. `.bak`, `.tmp`, WAL/SHM, and local SQLite files must never be release source.
EXIT: local runtime data can exist during development without polluting release state or customer evidence.

REDLINE: data residency is not finished until storage, compute, artifacts, captures, exports, and account UI share one region policy.
ACTION: CREATE `src/data/residency-policy.js` and `docs/internal/data-residency-matrix.json`.
CODE: region policy must include tenant region, allowed storage providers, forbidden transfer targets, compute regions, artifact export regions, backup regions, subprocessor list, account display state, and route enforcement. Violations return typed problems before work starts.
EXIT: EU/GDPR/data-residency copy is backed by enforceable routing and storage decisions.

#### Tenant, State, Data Plane, And Lifecycle Implementation Blueprint

CURRENT CUT: `src/store.js`, `src/event-store.js`, `src/auth.js`, `src/audit-retention.js`, `src/data-residency.js`, `src/billing-upgrade.js`, `src/object-storage.js`, `src/privacy-membrane.js`, and the capture/team/audit modules already contain real data logic. The product gap is that they do not yet share one tenant/data state machine. Finished Kolm needs a canonical data plane that makes tenant ownership, lifecycle, retention, residency, billing, artifact storage, and observability move together.

SOURCE ANCHORS: OWASP API Security Top 10 2023 names object/function/property authorization, resource consumption, sensitive business flows, SSRF, inventory, and unsafe upstream consumption as API risks. OWASP ASVS 5.0.0 is a requirement-addressable verification standard. NIST Privacy Framework defines privacy risk management for products and services. RFC 9457 is the HTTP problem-details error contract. Stripe idempotency guidance defines safe retry semantics for create/update operations. S3 security guidance requires least privilege, temporary credentials, and encryption decisions. OpenTelemetry HTTP and GenAI semantic conventions should shape traces/metrics for API and model operations.

REDLINE: tenant identity is represented by names, ids, email, API-key hash, anonymous tenant state, plan, country, geo check, and soft deletion across multiple stores without one tenant aggregate.
ACTION: CREATE `src/tenant/tenant-state.js`, `src/tenant/tenant-repository.js`, `src/tenant/tenant-events.js`, `src/tenant/tenant-authz.js`, `docs/internal/tenant-state-machine.json`, and `scripts/build-tenant-state-machine.cjs`; WIRE `src/auth.js`, `src/teams.js`, `src/team.js`, `src/router.js`, `src/store.js`, `src/event-store.js`, account pages, CLI `whoami`, and product graph.
CODE: tenant state is one aggregate with these canonical fields: `tenant_id`, `tenant_slug`, `display_name`, `kind`, `email`, `plan_id`, `entitlements`, `api_key_prefixes`, `session_state`, `country_code`, `geo_check`, `residency_region`, `storage_provider`, `created_at`, `claimed_at`, `last_login_at`, `disabled_at`, `deleted_at`, and `legal_hold_state`.
CODE: tenant transitions are explicit: `anonymous_created`, `claimed`, `oauth_linked`, `api_key_rotated`, `plan_changed`, `team_joined`, `geo_denied`, `disabled`, `delete_requested`, `deleted`, `restored`, and `legal_hold_applied`. Each transition declares preconditions, writes, emitted events, audit event, account state, CLI output, rollback/compensation, and problem details.
EXIT: no route, CLI command, account page, or worker guesses tenant state from loose rows or tenant names.

REDLINE: JSON file store, SQLite store, event-store SQLite/JSONL fallback, object storage, and local artifact paths have separate readiness and failure semantics.
ACTION: CREATE `src/data/data-plane.js`, `src/data/storage-topology.js`, `src/data/data-plane-readiness.js`, `docs/internal/data-plane-topology.json`, and `scripts/build-data-plane-topology.cjs`.
CODE: data-plane topology rows declare store id, driver, path/bucket/table, tenant partition key, consistency model, transaction support, backup behavior, corruption recovery, encryption state, residency region, retention class, export class, deletion behavior, health command, and owner. Drivers include `json_table`, `sqlite_table`, `sqlite_event_log`, `jsonl_event_log`, `local_artifact_dir`, `s3_object_store`, `r2_rest`, `r2_s3`, `supabase_s3`, and `external_provider`.
CODE: every data write goes through a typed repository that returns one of `committed`, `duplicate_idempotency_key`, `validation_failed`, `authz_failed`, `quota_exceeded`, `storage_unavailable`, `residency_blocked`, `retention_blocked`, `legal_hold_blocked`, or `corruption_recovered`. Raw `insert`, `update`, `appendFileSync`, and direct object put calls are allowed only inside repository modules.
EXIT: local JSON, SQLite, event logs, artifact objects, and cloud storage expose one readiness and failure vocabulary to API, CLI, account, and docs.

REDLINE: object-level authorization is not enforceable until every stored object type has an authz policy.
ACTION: CREATE `src/authz/object-policy.js`, `src/authz/object-scope.js`, `docs/internal/object-authorization-matrix.json`, and `scripts/build-object-authorization-matrix.cjs`.
CODE: each object type declares id pattern, tenant field, team field, namespace field, owner field, role requirement, plan requirement, read/write/delete/export policy, cross-tenant denial, service-account behavior, admin bypass policy, and audit event. Required object types include tenants, teams, team members, API keys, captures, observations, artifacts, jobs, distill runs, datasets, evals, benchmarks, marketplace listings, tunnels, storage objects, audit events, invoices, upgrade requests, redaction vaults, and residency tags.
CODE: route handlers must not call `all()`, `findOne()`, `update()`, or event-store list functions directly for tenant-scoped objects. They call repository methods that enforce object policy before data access.
EXIT: OWASP API1/API3/API5 risks are addressed by code structure, not comments.

REDLINE: mutating routes do not share a universal idempotency, audit, and compensation policy.
ACTION: CREATE `src/http/idempotency.js`, `src/http/mutation-contract.js`, `src/http/problem-details.js`, `docs/internal/mutation-contract.json`, and `scripts/build-mutation-contract.cjs`.
CODE: every `POST`, `PUT`, `PATCH`, and `DELETE` declares idempotency mode: `required`, `accepted`, `ignored`, or `forbidden`. For required/accepted modes, the implementation stores key, tenant, route, request hash, response status, response body hash, started_at, completed_at, expiry, and conflict behavior. Reusing a key with different parameters returns a typed RFC 9457 problem.
CODE: every mutation declares audit event, side effects, compensation, retryability, timeout, lock scope, concurrency behavior, and account/CLI user-visible state. Stripe-like create/update retries must be safe; destructive operations require confirmation and record an audit event id.
EXIT: retries cannot double-create jobs, artifacts, plans, keys, exports, storage objects, or team actions.

REDLINE: privacy membrane, redaction vaults, capture forget, export, delete, retention, legal hold, and residency policies are separate mechanisms.
ACTION: CREATE `src/data/data-subject-request.js`, `src/data/privacy-workflow.js`, `src/data/legal-hold-policy.js`, `docs/internal/privacy-workflow-matrix.json`, and `scripts/build-privacy-workflow-matrix.cjs`.
CODE: privacy workflows declare data subject, verified tenant, identity proof, data classes, search scope, redaction policy, export format, delivery channel, deletion/retention effect, legal hold blockers, residency constraints, deadline, audit events, and customer-visible state. Workflow states are `received`, `identity_required`, `collecting`, `redacting`, `awaiting_approval`, `ready`, `delivered`, `deleting`, `deleted`, `blocked_by_legal_hold`, `blocked_by_retention`, `failed`, and `expired`.
CODE: capture-forget and redaction vault deletion must produce a tombstone with tenant, class, object ids, actor, reason, and irreversible/retained fields. Audit logs keep integrity metadata but not raw deleted content.
EXIT: privacy rights are implemented workflows with evidence, not scattered helper routes.

REDLINE: billing, quota, rate limit, usage, cost, and ROI data are not yet one financial ledger.
ACTION: CREATE `src/commercial/financial-ledger.js`, `src/commercial/quota-engine.js`, `src/commercial/usage-meter.js`, `src/commercial/idempotent-billing.js`, `docs/internal/financial-ledger-contract.json`, and `scripts/build-financial-ledger-contract.cjs`.
CODE: financial ledger entries declare tenant, account, plan, entitlement, unit, quantity, provider, model, route, artifact/job id, cost basis, customer price, currency, timestamp, idempotency key, invoice linkage, and reversal/adjustment state. Usage and quota decisions read the ledger, not ad hoc counters.
CODE: upgrade fallback rows, Stripe checkout sessions, webhook events, manual enterprise requests, marketplace entitlements, and local plan aliases all flow through one subscription state machine. `paid`, `checkout_started`, `invoice_paid`, `active`, `past_due`, `canceled`, `sales_required`, and `manual_pending` are distinct states.
EXIT: account billing, `/v1/plans`, CLI billing tiers, pricing copy, and route quota enforcement cannot disagree.

REDLINE: audit retention and audit export exist, but audit is not yet an append-only product evidence spine across all critical actions.
ACTION: CREATE `src/audit/audit-ledger.js`, `src/audit/audit-chain.js`, `src/audit/audit-policy.js`, `docs/internal/audit-event-catalog.json`, and `scripts/build-audit-event-catalog.cjs`.
CODE: audit events are append-only, hash-chained per tenant, typed, retention-scoped, exportable, and redaction-aware. Required event families: auth, key rotation, team membership, role change, capture, redaction, artifact build, artifact publish, distill job, eval result, billing, storage readiness, residency decision, export/delete request, legal hold, admin action, worker job, marketplace listing, and deployment.
CODE: each audit event declares actor, subject, target object, route/command, request id, idempotency key, before/after summaries, sensitive fields omitted, retention class, and external evidence visibility. Audit export must preserve chain verification without leaking secrets or deleted raw payloads.
EXIT: enterprise governance can show real event lineage for product actions instead of isolated logs.

REDLINE: object storage readiness currently reports providers, but artifact storage security and lifecycle are not fully encoded.
ACTION: CREATE `src/storage/artifact-storage-policy.js`, `src/storage/artifact-object-lifecycle.js`, `docs/internal/artifact-storage-policy.json`, and `scripts/build-artifact-storage-policy.cjs`.
CODE: each storage provider row declares credential mode, long-lived credential risk, least-privilege policy template, encryption mode, public access state, bucket/object naming, max object size, multipart support, checksum/signature mode, lifecycle/retention, region, residency compatibility, delete semantics, listing semantics, signed URL policy, smoke command, and account display state.
CODE: local artifact storage is never called cloud-ready. Cloud storage cannot be called configured until credentials, bucket, write/read/head/delete smoke, max object path, encryption, and public-access state are verified without secret values in output.
EXIT: artifact storage claims are backed by security policy, lifecycle, and real round-trip proof.

REDLINE: observability exists in pieces, but data-plane, route, model, worker, and billing operations do not share a semantic telemetry contract.
ACTION: CREATE `src/observability/semantic-events.js`, `src/observability/telemetry-contract.js`, `docs/internal/telemetry-contract.json`, and `scripts/build-telemetry-contract.cjs`.
CODE: telemetry rows declare span name, metric name, log event, route/command, tenant-safe dimensions, model/provider fields, artifact/job fields, storage fields, cost fields, error fields, sample policy, privacy class, and retention. HTTP spans use OpenTelemetry HTTP conventions. Model/provider operations use GenAI conventions where applicable. Business metrics include captures, distill jobs, artifacts built, route savings, quota denials, storage readiness, billing state changes, and failed user actions.
CODE: secret values, prompts, PHI/PII, raw API keys, bearer tokens, private keys, and customer payloads are never telemetry attributes. Hashes, classes, counts, and scoped ids are allowed only when declared.
EXIT: production can answer what failed, which tenant/product surface was affected, what it cost, whether it retried, and what the user should do next.

REDLINE: data corruption recovery exists for JSON tables, but backup, restore, migration, and disaster recovery are not a full product surface.
ACTION: CREATE `src/data/backup-restore.js`, `src/data/migration-ledger.js`, `src/data/disaster-recovery.js`, `docs/internal/backup-restore-runbook.json`, and `scripts/build-backup-restore-runbook.cjs`.
CODE: every store declares backup frequency, backup destination, restore command, schema version, migration command, rollback command, corruption quarantine path, recovery evidence, and maximum data loss objective. Local development backups are short-lived managed artifacts; production backups are encrypted, region-scoped, and access-controlled.
CODE: migrations are append-only records with migration id, input schema, output schema, rows affected, tenant scope, dry-run result, live-run result, rollback/irreversible marker, and account/customer impact.
EXIT: data durability means tested backup/restore and migrations, not only atomic writes.

#### Security, Privacy, And AI Trust Implementation Blueprint

SOURCE ANCHORS: OWASP LLM Top 10 2025, OWASP API Security Top 10 2023, RFC 9700 OAuth 2.0 Security BCP, RFC 7644 SCIM, NIST AI RMF / Generative AI Profile, NIST Privacy Framework, and NIST CSF 2.0 must be treated as implementation inputs, not trust-page references.

REDLINE: API keys, OAuth cookies, tenant identity, team roles, SSO, SCIM, service tokens, and demo sessions do not yet share one security boundary model.
ACTION: CREATE `src/security/trust-boundary-contract.js`, `src/security/principal.js`, `src/security/session-policy.js`, `src/security/access-decision.js`, and `docs/internal/trust-boundary-map.json`; WIRE `src/auth.js`, `src/oauth.js`, `src/team.js`, `src/teams.js`, `src/team-capture-rbac.js`, account pages, CLI auth, and every route wrapper to it.
CODE: every request principal must be normalized before business logic:

```js
principal = resolvePrincipal({
  apiKey,
  sessionCookie,
  oauthUser,
  serviceToken,
  scimToken,
  demoToken,
  sourceIp,
  userAgent,
  route,
});
decision = authorize(principal, {
  action: 'artifact.read',
  tenant_id,
  team_id,
  object_type: 'artifact',
  object_id,
  object_owner_tenant_id,
  fields: ['manifest', 'metrics', 'receipt'],
});
```

CODE: the decision object must include `allow`, `reason`, `policy_id`, `tenant_scope`, `team_scope`, `field_scope`, `redacted_fields`, `evidence_id`, and `audit_event_id`. Every denial returns a typed problem without leaking whether a foreign object exists.
EXIT: OWASP API1/API3/API5 class bugs cannot be introduced by adding a new route, because object, property, and function authorization are one mandatory primitive.

REDLINE: secrets are currently scattered across env vars, local vault records, provider credentials, storage credentials, OAuth client secrets, Stripe keys, webhook secrets, API keys, and generated evidence.
ACTION: CREATE `src/security/secret-inventory.js`, `src/security/secret-redaction.js`, `src/security/secret-rotation.js`, `scripts/build-secret-inventory.cjs`, and `docs/internal/secret-inventory.json`; WIRE `src/secrets-vault.js`, provider readiness, object storage readiness, OAuth, billing, telemetry, docs generation, and reports.
CODE: every secret class must declare id, owner, source, runtime surface, rotation cadence, last_rotated_at, storage backend, display policy, env var names, readiness probe, fallback behavior, leak regex, redaction replacement, and revoke procedure.
CODE: every JSON/HTML/Markdown generation path must run `redactSecretEnvelope()` before write; every readiness response must include `secret_values_included:false`; every log path must prove it uses the redaction primitive.
EXIT: a secret cannot appear in OpenAPI, docs, screenshots, audit reports, local surface reports, product graph output, CLI JSON, TUI JSON, or error bodies.

REDLINE: OAuth is implemented but not yet a complete RFC 9700-grade auth product.
ACTION: CREATE `src/security/oauth-security-profile.js`, `src/security/cookie-policy.js`, and `docs/internal/oauth-security-profile.json`; WIRE Google/GitHub OAuth, future enterprise OIDC, account session UI, logout, key rotation, device sessions, and route auth middleware.
CODE: OAuth code flow must enforce exact redirect URI, state binding, PKCE for public clients, issuer/provider binding, token response validation, bounded return URLs, CSRF protection for session-changing endpoints, refresh/session expiry, idle timeout, logout invalidation, and one-time API key reveal.
CODE: cookie policy must explicitly set `httpOnly`, `secure`, `sameSite`, path, TTL, regeneration-on-login, invalidation-on-rotation, and environment-specific refusal to set production cookies on non-HTTPS origins.
EXIT: OAuth login is not a convenience wrapper around API key rotation; it is a full identity state machine with observable security posture and recovery paths.

REDLINE: Enterprise identity is not finished until SSO, SCIM, RBAC, audit, and deprovisioning are a single contract.
ACTION: CREATE `src/security/enterprise-identity.js`, `src/security/scim-server.js`, `src/security/saml-oidc-config.js`, and `docs/internal/identity-protocol-contract.json`; WIRE enterprise setup APIs, account enterprise settings, product graph readiness, audit export, and support diagnostics.
CODE: SCIM must implement Users, Groups, filtering, pagination, PATCH, active/deactivated state, externalId, group membership replacement, idempotent create/update, service provider config, schemas, resource types, token rotation, ETag/If-Match where supported, and tenant isolation for all identifiers.
CODE: SSO must implement metadata ingest, issuer, ACS URL, entity ID, cert validity, cert rotation warnings, group claim mapping, JIT provisioning, denied-domain states, break-glass admin, and test-login state.
EXIT: an enterprise admin can configure, test, activate, monitor, rotate, deprovision, and export identity evidence without support hand edits.

REDLINE: LLM security controls are fragmented across guardrails, redaction, poisoning, adversarial prompt fixtures, and runtime policy.
ACTION: CREATE `src/security/llm-threat-controls.js`, `src/security/tool-output-firewall.js`, `src/security/prompt-injection-policy.js`, `src/security/model-supply-chain-policy.js`, and `docs/internal/llm-threat-control-matrix.json`; WIRE capture, live demo runner, agents, MCP, guardrails, distill, train, import/export, runtime inference, and account risk pages.
CODE: implement one control matrix for OWASP LLM risks:

```json
{
  "prompt_injection": ["instruction_hierarchy", "tool_output_quarantine", "retrieval_source_labels", "agent_action_approval"],
  "sensitive_information_disclosure": ["privacy_membrane", "secret_redaction", "field_level_output_policy"],
  "supply_chain": ["artifact_signature", "model_source_attestation", "dependency_sbom", "loader_quarantine"],
  "data_poisoning": ["capture_poisoning_detection", "teacher_version_tagging", "label_anomaly_review"],
  "improper_output_handling": ["schema_validation", "safe_renderer", "tool_argument_validation"],
  "excessive_agency": ["least_privilege_tools", "human_approval", "budget_limits", "network_policy"],
  "system_prompt_leakage": ["prompt_secrets_ban", "debug_scope_gate", "red_team_fixtures"],
  "model_denial_of_service": ["token_budget", "media_size_limits", "rate_limits", "queue_backpressure"],
  "model_theft": ["artifact_access_policy", "export_controls", "download_anomaly_detection"]
}
```

EXIT: every AI capability ships with threat controls, tests, account-visible risk state, and a refusal to market unimplemented controls as shipped.

REDLINE: tool use, MCP, browser demos, external provider calls, object storage, webhooks, and remote compute are SSRF/exfiltration surfaces unless egress is centrally governed.
ACTION: CREATE `src/security/egress-policy.js`, `src/security/url-safety.js`, `src/security/network-budget.js`, and `docs/internal/provider-egress-policy.json`; WIRE provider adapters, object storage adapters, OAuth token exchange, webhooks, MCP tools, remote compute, live demo runner, and artifact import.
CODE: every outbound request must pass host allow/deny policy, scheme policy, DNS rebinding defense, private-IP block, redirect policy, max body bytes, max response bytes, timeout, retry budget, credential binding, request classification, and audit event creation.
CODE: tenant-configured endpoints must be stored as policy objects, not raw URLs, with validation results and last_verified_at. Error bodies must not include credentials, resolved private IPs, or provider response secrets.
EXIT: OWASP API7 SSRF and unsafe API consumption are blocked at the shared client layer instead of route-specific judgment calls.

REDLINE: `.kolm` artifacts are the product's security boundary, but trust policy is not yet an explicit runtime object.
ACTION: CREATE `src/security/artifact-trust-policy.js`, `src/security/artifact-quarantine.js`, `src/security/provenance-verifier.js`, and `docs/internal/artifact-trust-policy.json`; WIRE artifact load, verify, import, export, registry, marketplace, distill outputs, compile outputs, account artifacts, and CLI verify.
CODE: every artifact state must be one of `untrusted`, `quarantined`, `signature_valid`, `provenance_valid`, `policy_allowed`, `runtime_allowed`, `revoked`, or `expired`. Runtime load requires signature, hash, manifest schema, provenance, dependency inventory, declared capabilities, allowed tools, data policy, and tenant permission.
CODE: key rotation, trust root updates, revocation lists, expired signing keys, provenance mismatch, unsafe loader target, and unknown format version must be first-class failure modes with user-facing remediation.
EXIT: no imported artifact can run because it is syntactically valid; it runs only after policy says it is trusted for that tenant, runtime, and action.

REDLINE: compliance pages and certification packets exist, but product trust is not complete until evidence is generated from production controls.
ACTION: CREATE `src/security/compliance-evidence-model.js`, `src/security/control-evidence-store.js`, `src/security/trust-center-state.js`, `public/account/trust-center.html`, and `docs/internal/compliance-control-map.json`; WIRE `src/compliance-certification-packet.js`, `src/evidence-readiness.js`, `src/audit-export.js`, release provenance, local surface probes, account enterprise pages, and public trust pages.
CODE: every control must distinguish `not_started`, `implemented`, `evidence_collecting`, `evidence_collected`, `auditor_review`, `attested`, `certified`, `expired`, and `out_of_scope`. Public pages may only say certified when the evidence store contains issuer, issued_at, expires_at, scope, signature/hash, and public or customer-visible evidence URL.
CODE: map SOC 2, ISO 27001, HIPAA BAA, GDPR DPA, EU AI Act, FedRAMP boundary, SLSA, SBOM, NIST CSF, NIST Privacy Framework, and NIST AI RMF to implemented controls and missing external proof.
EXIT: trust copy, sales packets, account exports, and API readiness return the same compliance truth and cannot overclaim.

REDLINE: privacy membrane, redaction, retention, data rights, and AI risk classification are separate features when they should be one privacy-risk system.
ACTION: CREATE `src/security/privacy-risk-engine.js`, `src/security/privacy-rights-workflow.js`, `src/security/sensitive-output-policy.js`, and `docs/internal/privacy-risk-register.json`; WIRE `src/privacy-membrane.js`, `src/phi-redactor.js`, `src/privacy-events.js`, `src/audit-retention.js`, `src/data-residency.js`, account privacy pages, and demo/capture pipelines.
CODE: every capture/distill/inference/export path must compute privacy risk from data classes, subject identifiers, geography, provider egress, retention, redaction policy, user consent basis, legal hold, and downstream model-training use.
CODE: rights workflows must cover access, export, delete, portability, rectification, consent withdrawal, retention override, legal hold, and subprocessor disclosure. Each state transition requires actor, timestamp, reason, evidence, and customer-visible status.
EXIT: privacy is enforceable in data movement and account actions, not a policy page.

REDLINE: security red teaming is not finished if it is only fixture tests.
ACTION: CREATE `src/security/red-team-harness.js`, `src/security/security-attack-fixtures.js`, `scripts/run-security-redteam.cjs`, and `docs/internal/security-red-team-cases.json`; WIRE CI, local release verify, account trust center evidence, and product readiness closeout.
CODE: the harness must execute prompt injection, tool output injection, malicious `.kolm`, poisoned capture, schema bypass, path traversal, zip bomb, SSRF, webhook replay, object-level auth bypass, object-property leak, overlong media, provider credential exfiltration, system prompt disclosure, model theft, and tenant boundary attempts.
CODE: each case must record input, expected block/redact/allow decision, touched controls, request id, evidence id, tenant/team, and remediation owner on failure.
EXIT: a future implementation agent has runnable attacks, not a vague instruction to improve security.

REDLINE: incident response is not a product surface yet.
ACTION: CREATE `src/security/incident-state-machine.js`, `src/security/security-event-classifier.js`, `src/security/customer-notification.js`, and `docs/internal/security-incident-runbook.json`; WIRE audit events, secret leak detection, poisoning detection, failed auth, provider egress violations, compliance evidence, and account notifications.
CODE: incident states must include `detected`, `triaged`, `contained`, `rotating_credentials`, `customer_review`, `notified`, `remediated`, `postmortem`, and `closed`. Every state change requires actor, severity, affected tenants, affected data classes, evidence, and customer-visible message policy.
EXIT: severe security events produce deterministic containment, customer communication, and proof, not ad hoc log review.

#### AI Trust, Safety, Compliance, And Provenance Execution Blueprint

SOURCE ANCHORS: OWASP LLM Top 10 2025 names prompt injection, sensitive information disclosure, supply chain, data/model poisoning, improper output handling, excessive agency, system prompt leakage, vector/embedding weaknesses, misinformation, and unbounded consumption as current LLM risk classes. NIST AI RMF and NIST AI 600-1 require govern/map/measure/manage treatment of generative AI risks. The EU AI Act uses risk tiers and requires high-risk systems to carry risk management, dataset quality, logging, documentation, deployer information, human oversight, robustness, cybersecurity, and accuracy controls. HHS HIPAA de-identification guidance distinguishes simple identifier removal from statistical linkage risk and expert mitigation. Sigstore, SLSA 1.2, and CycloneDX 1.7 define the software and artifact provenance standard we should match.

REDLINE: trust logic exists in separate files, but there is no runtime authority that makes `src/privacy-membrane.js`, `src/phi-redactor.js`, `src/prompt-redactor.js`, `src/guardrails.js`, `src/runtime-policy.js`, `src/poisoning-orchestrator.js`, `src/audit.js`, `src/artifact.js`, `src/auditor-attestation.js`, `src/compliance-certification-packet.js`, `src/sbom-emit.js`, and `src/kscore.js` act like one product.
ACTION: CREATE `src/trust/trust-control-plane.js`, `src/trust/control-registry.js`, `src/trust/control-decision.js`, `src/trust/evidence-ledger.js`, `docs/internal/ai-trust-control-plane.json`, and `scripts/build-ai-trust-control-plane.cjs`.
CODE: every control registers through one object:

```js
registerTrustControl({
  id: 'capture_poisoning',
  standard_refs: ['owasp-llm04-2025', 'nist-ai-rmf-measure', 'eu-ai-act-logging'],
  phase: ['capture', 'distill', 'eval'],
  mode: 'enforce',
  default_action: 'quarantine',
  input_schema: 'trust.capture.v1',
  output_schema: 'trust.decision.v1',
  evidence_schema: 'trust.evidence.v1',
  user_visible_state: true,
  bypass_policy: 'security_exception_required',
  owner: 'backend',
});
```

CODE: trust decisions must have `allow`, `action`, `severity`, `control_id`, `policy_id`, `tenant_id`, `team_id`, `resource_type`, `resource_id`, `phase`, `reason_code`, `standard_refs`, `evidence_id`, `audit_event_id`, `customer_visible`, `expires_at`, and `remediation`. If a decision is not represented by this schema, it is not product-grade.
CODE: the trust control plane must be called from capture ingest, demo runner, provider calls, train/distill jobs, artifact compile/sign/import/load/export, runtime inference, registry publishing, marketplace install, account evidence pages, CLI JSON, TUI JSON, and product graph readiness.
EXIT: a new AI feature cannot bypass privacy, poisoning, guardrail, provenance, compliance, audit, and customer-visible evidence by adding a route or helper.

REDLINE: prompt injection is still treated as patterns and guardrails, but product-grade agent safety requires an instruction hierarchy and tool boundary.
ACTION: CREATE `src/trust/prompt-injection-policy.js`, `src/trust/instruction-hierarchy.js`, `src/trust/tool-boundary.js`, `src/trust/tool-output-quarantine.js`, and `docs/internal/llm-threat-model.json`.
CODE: each LLM call must declare system instructions, developer instructions, user input, retrieved content, tool output, memory, hidden policy, and customer data as separate channels. The executor must preserve channel labels through routing, caching, distillation, artifact compilation, and runtime replay.
CODE: tool output can never be concatenated into instructions without a quarantine decision. Tool output policy must classify source, URL, MIME type, tenant trust state, data class, freshness, signature, allowed actions, and whether it can influence tool selection, model instruction, user-visible text, or only citations.
CODE: agents and MCP flows must declare `allowed_tools`, `allowed_domains`, `allowed_data_classes`, `max_tool_calls`, `max_spend_usd`, `human_approval_required`, `write_actions_allowed`, `network_allowed`, and `secret_access_allowed`; runtime denies undeclared tool use before provider calls.
EXIT: Kolm can show an enterprise buyer exactly how prompt injection is isolated, not just claim it has guardrails.

REDLINE: `src/poisoning-orchestrator.js` exists, but capture poisoning is not finished until it owns the training-use state of every row.
ACTION: CREATE `src/trust/capture-poisoning-policy.js`, `src/trust/capture-training-eligibility.js`, `src/trust/capture-quarantine-store.js`, and `docs/internal/capture-poisoning-contract.json`; TREAT `src/poisoning-orchestrator.js` as the current canonical detector and either rename/import-stabilize it or add a compatibility wrapper at `src/capture-poisoning.js`.
CODE: every captured row must carry `teacher_binding`, `teacher_version`, `provider`, `model`, `prompt_hash`, `response_hash`, `capture_source`, `namespace`, `tenant_id`, `team_id`, `labels`, `data_classes`, `copyright_risk`, `anomaly_axes`, `poisoning_risk`, `quarantine_state`, `training_eligible`, `review_required`, `reviewer_id`, and `reviewed_at`.
CODE: training/distillation code must refuse rows with `training_eligible:false`, unverified HMAC where policy requires binding, unresolved copyright quarantine, label conflict above threshold, namespace distribution shift above threshold, prompt injection marker above threshold, or tenant policy mismatch.
CODE: account UI must expose quarantined captures, reason codes, sample payload shape after redaction, unblock/reject actions, reviewer notes, and downstream jobs prevented from using them.
EXIT: a poisoned capture cannot silently enter a student model, K-score fixture, benchmark, registry artifact, or public demo.

REDLINE: PHI/PII redaction is split between general privacy membrane, HIPAA regex redactor, prompt redactor, and output policy; HHS de-identification guidance makes plain regex removal insufficient for healthcare claims.
ACTION: CREATE `src/trust/redaction-policy.js`, `src/trust/deidentification-risk.js`, `src/trust/reidentification-linkage-risk.js`, `docs/internal/deidentification-method-contract.json`, and `public/account/deidentification.html`.
CODE: every redaction decision must state `method` as one of `safe_harbor_identifier_removal`, `expert_determination_required`, `policy_redaction`, `secret_redaction`, `prompt_literal_removal`, or `output_sensitive_suppression`.
CODE: healthcare and regulated workflows must compute linkage risk from quasi-identifiers, demographics, dates, geography, rare conditions, public-record replicability, row uniqueness, and data utility loss. Regex-only safe-harbor mode may not be marketed as expert determination.
CODE: `src/privacy-membrane.js`, `src/phi-redactor.js`, and `src/prompt-redactor.js` must emit the same token map envelope with `class`, `start`, `end`, `replacement`, `hash`, `recoverable`, `policy_action`, `subject_scope`, `confidence`, and `benchmark_scope`.
CODE: reinjection must require tenant permission, purpose, original event id, map hash, expiry, actor, audit event, and no provider egress unless policy allows it.
EXIT: Kolm can safely tell a healthcare buyer what de-identification mode ran, what it does not prove, and which data never left their boundary.

REDLINE: guardrails are artifact-level rules today; improper output handling requires typed schemas, renderers, and tool argument validation.
ACTION: CREATE `src/trust/output-contract.js`, `src/trust/schema-output-validator.js`, `src/trust/safe-renderer-policy.js`, and `docs/internal/output-handling-contract.json`; WIRE `src/guardrails.js`, structured output routes, tool calls, account demos, docs API explorer, and runtime inference.
CODE: each model response must have `declared_output_type`, `schema_id`, `schema_version`, `validation_result`, `renderer`, `tool_argument_policy`, `guardrail_result`, and `unsafe_output_action`.
CODE: HTML, Markdown, JSON, SQL, shell, URL, FHIR, CSV, file path, and tool-call outputs must have separate validators and renderers. A response that validates as text is not automatically safe as HTML, SQL, shell, path, URL, or tool arguments.
CODE: structured outputs must support `repair_attempted`, `repair_model`, `repair_diff`, `final_valid`, and `refused_to_repair` so evals and account UI can distinguish native valid output from repaired output.
EXIT: a prompt cannot turn model text into executable browser, shell, webhook, storage, or agent behavior without passing a typed output boundary.

REDLINE: K-score exists, but it cannot become the yardstick until calibration, uncertainty, and claim scope are first-class data.
ACTION: CREATE `src/trust/kscore-calibration-ledger.js`, `src/trust/eval-claim-scope.js`, `docs/internal/kscore-methodology-spec.json`, `public/kscore-methodology.json`, and `public/account/evaluation-calibration.html`.
CODE: every K-score result must carry `method_version`, `axis_versions`, `dataset_id`, `dataset_hash`, `task_type`, `domain`, `language`, `human_label_count`, `judge_model`, `judge_prompt_hash`, `confidence_interval`, `sample_size`, `subgroup_results`, `known_failures`, `calibration_set`, `last_calibrated_at`, and `claim_scope`.
CODE: marketing, API docs, account UI, benchmark pages, registry cards, artifact manifests, and sales exports must consume `eval-claim-scope`, not raw K-score numbers. If `claim_scope` is `synthetic_public_fixture_only`, copy must say that.
CODE: publish a deterministic local K-score calculator and a separately versioned calibration dataset. The public calculator must reproduce artifact scores from raw fixture files without private services.
EXIT: K-score becomes an implementable standard with statistical evidence, not a proprietary number users must trust.

REDLINE: artifact signing, auditor attestation, SBOM, SLSA, and compliance packet code exists, but the artifact trust story is not yet a single chain from source to runtime.
ACTION: CREATE `src/trust/artifact-evidence-chain.js`, `src/trust/provenance-policy.js`, `src/trust/model-bom.js`, `src/trust/attestation-verifier.js`, `docs/internal/artifact-evidence-chain.json`, and `public/account/artifact-trust.html`.
CODE: the evidence chain must bind source commit, build command, builder identity, package lock hash, SBOM hash, model weight manifest hash, teacher response HMAC policy, eval dataset hash, K-score hash, guardrail hash, redaction policy hash, artifact hash, signature, Sigstore bundle/Rekor entry when available, auditor attestation, registry publish event, runtime load event, and revocation status.
CODE: update SBOM policy from CycloneDX 1.5-only to an explicit compatibility matrix: emit current CycloneDX 1.7 where supported, preserve SPDX 2.3, and record why any artifact remains on an older schema.
CODE: SLSA policy must target SLSA 1.2 build and source tracks, with build provenance and source provenance stored as first-class evidence objects, not only docs copy.
EXIT: an enterprise security reviewer can trace any `.kolm` artifact from source and training data policy to runtime execution and revocation.

REDLINE: compliance controls are implemented as local evidence and templates, but they are not a continuously updated product surface.
ACTION: CREATE `src/trust/compliance-scope.js`, `src/trust/compliance-claim-ledger.js`, `src/trust/regulatory-risk-classifier.js`, `docs/internal/compliance-claim-ledger.json`, and `public/account/compliance-scope.html`.
CODE: every public or sales-facing compliance claim must be represented as:

```json
{
  "claim_id": "hipaa-deidentification-safe-harbor",
  "text": "PHI redaction can remove Safe Harbor identifiers",
  "status": "implemented_not_certified",
  "evidence_paths": ["src/phi-redactor.js", "src/trust/redaction-policy.js"],
  "external_evidence_required": ["legal_review", "customer_baa"],
  "forbidden_phrases": ["HIPAA certified", "guaranteed de-identified"],
  "customer_visible_scope": "regex and policy controls; expert determination not included"
}
```

CODE: EU AI Act product behavior must classify use case risk, GPAI exposure, transparency obligations, human oversight requirement, serious-incident path, logging retention, post-market monitoring, and prohibited-use refusal before enabling regulated vertical claims.
CODE: SOC 2, ISO 27001, FedRAMP, HIPAA BAA, GDPR DPA, SLSA, SBOM, NIST AI RMF, NIST Privacy Framework, and NIST CSF statuses must be emitted from the same ledger to public trust pages, account exports, API readiness, CLI, TUI, and sales packets.
EXIT: there is no second copy of compliance truth hidden in pages, docs, README, or sales language.

REDLINE: audit events are append-only, but evidence is not yet a cross-product query model.
ACTION: CREATE `src/trust/evidence-query.js`, `src/trust/evidence-export.js`, `src/trust/evidence-retention.js`, and `public/account/evidence.html`; WIRE `src/audit.js`, `src/audit-export.js`, `src/audit-retention.js`, product graph, and compliance packet generation.
CODE: evidence records must support immutable event hash, parent hash, tenant, team, actor, route, CLI command, artifact id, job id, policy id, control id, source path, code version, environment, timestamp, retention class, export eligibility, redaction state, customer visibility, and legal hold.
CODE: every account action that changes trust state must show an evidence id. Every API response that blocks, redacts, quarantines, signs, verifies, rotates, revokes, or exports must include an evidence id or explain why no evidence was produced.
EXIT: audit logs are not just logs; they are the product evidence layer.

REDLINE: exception handling is the place where security products usually fail.
ACTION: CREATE `src/trust/security-exception.js`, `src/trust/exception-policy.js`, `docs/internal/security-exception-contract.json`, and `public/account/security-exceptions.html`.
CODE: bypasses must require `control_id`, `resource_type`, `resource_id`, `tenant_id`, `requester`, `approver`, `reason`, `risk_acceptance`, `expires_at`, `compensating_controls`, `customer_visible`, and `revalidation_job`.
CODE: expired exceptions must fail closed. Exceptions cannot disable secret redaction, tenant authorization, signature verification for imported artifacts, or evidence creation.
EXIT: product teams can move fast without hidden permanent trust bypasses.

REDLINE: current trust controls do not yet have a route/API/account surface contract.
ACTION: ADD these backend-owned API surfaces: `GET /v1/trust/controls`, `GET /v1/trust/decisions`, `GET /v1/trust/evidence/:id`, `GET /v1/trust/artifacts/:id/chain`, `GET /v1/trust/compliance/claims`, `POST /v1/trust/exceptions`, `POST /v1/trust/redaction/preview`, `POST /v1/trust/poisoning/assess`, and `POST /v1/trust/output/validate`.
CODE: every route must declare auth, tenant boundary, pagination, filtering, redaction policy, evidence id, rate limit, problem variants, SDK examples, CLI equivalent, and account page.
CODE: account must expose a Trust Center with four working tabs: `Controls`, `Findings`, `Evidence`, and `Exceptions`. Each tab must render real backend state, not static trust copy.
EXIT: trust becomes a product workflow that users can operate, export, and inspect.

REDLINE: the current security code still contains mojibake/comment corruption in several headers, which weakens customer-facing credibility when snippets are shown or docs are generated.
ACTION: NORMALIZE source comments and generated docs around trust/security modules through a controlled text cleanup after concurrent agents finish, not by blind global replacement.
CODE: the cleanup must target exact corrupted separator/codepoint patterns in `src/poisoning-orchestrator.js`, `src/guardrails.js`, `src/auditor-attestation.js`, `src/sbom-emit.js`, docs generated from them, and any public HTML metadata derived from them. Each replacement must be reviewed in context so code semantics and examples do not change.
EXIT: generated docs, browser tabs, source headers, and public trust pages do not show encoding artifacts that make the product look unfinished.

#### Account Console, Product UX, Docs, And Discovery Implementation Blueprint

SOURCE ANCHORS: WCAG 2.2, WAI-ARIA Authoring Practices, Core Web Vitals (LCP/INP/CLS), Diataxis documentation structure, Google Search title-link guidance, Schema.org SoftwareApplication/WebApplication, and OpenAPI operation-level security metadata must be treated as implementation inputs.

REDLINE: account pages are generated and hand-edited in multiple styles, with 41 HTML files and several sidebar/nav variants.
ACTION: CREATE `public/account/account-shell.js`, `public/account/account-nav.js`, `public/account/account-state.js`, `public/account/account-fetch.js`, `public/account/account-actions.js`, `docs/internal/account-surface-matrix.json`, and `scripts/build-account-surface-matrix.cjs`; REPLACE page-local sidebar, auth, fetch, loading, empty, error, modal, and table behavior.
CODE: every account page row must declare slug, product surface, journey, API routes, CLI equivalent, TUI view, required auth, required plan, loading state, empty state, error state, partial/external-gated state, destructive actions, telemetry events, docs links, and owner.
CODE: page generation must read the matrix. A page cannot exist under `/account/*` unless it is `live_product`, `reference_only`, `internal_tool`, `archive`, or `blocked_external_gate`.
EXIT: post-auth UX is a governed product console, not a collection of pages that happen to share CSS.

REDLINE: account navigation is overloaded and inconsistent.
ACTION: CREATE `docs/internal/account-navigation-contract.json` and WIRE it into `public/account/account-nav.js`, account shell, public nav, breadcrumbs, sitemap exclusions, product graph, and docs cross-links.
CODE: account navigation groups must be:

```text
Command Center
Traffic And Capture
Data And Evaluation
Build And Distill
Artifacts And Runtime
Team And Governance
Billing And Usage
Operations And Trust
Developer Tools
```

CODE: each nav item declares label, short label, route, group, icon id, product surface, page status, badge source, auth/plan gate, mobile order, search aliases, and `aria-current` scope. Only one item in each nav set may carry `aria-current`.
EXIT: nav underlines, sidebars, breadcrumbs, active states, and mobile drawers are generated from one account navigation contract.

REDLINE: account UI does not yet expose the full product matrix as a usable operational flow.
ACTION: CREATE `public/account/product-command-center.js`, `public/account/product-matrix.js`, `docs/internal/account-product-command-contract.json`, and `public/account/product-map.html`; WIRE product graph, readiness closeout, build redline, artifact data plane, capture data plane, billing entitlements, and cloud readiness.
CODE: command center cards must show the three buyer-level loops and their operational children:

```text
Route and capture model traffic
Compile and distill task artifacts
Run and govern artifacts anywhere
```

CODE: each card shows current account state, required next action, live route/API proof, CLI command, docs tutorial, last successful smoke, missing credential/config, and whether the blocker is local code, customer configuration, package release, benchmark data, certification, or external partner adoption.
EXIT: users can open account and understand exactly which Kolm product loop is ready, blocked, or waiting for their action.

REDLINE: account pages use different loading, empty, error, disabled, partial, and success states.
ACTION: CREATE `public/account/state-panel.js`, `public/account/action-result.js`, `public/account/problem-view.js`, and `docs/internal/account-state-contract.json`; WIRE every account page and account fetch helper to these primitives.
CODE: canonical visual states are `loading`, `empty`, `needs_auth`, `needs_api_key`, `needs_plan`, `needs_credentials`, `needs_storage`, `needs_cloud`, `external_gated`, `sample_only`, `local_only`, `partial`, `ready`, `running`, `succeeded`, `failed`, `disabled`, and `danger`.
CODE: every state renders title, one-line cause, next action, retryability, command/API equivalent, support/evidence link, and machine code. Errors consume RFC 9457-style problem details where available.
EXIT: account UX never blanks, never silently falls back, and never makes users infer what to do next.

REDLINE: account actions such as revoke, rotate, approve, reject, publish, delete, smoke, deploy, cancel, retry, promote, and rollback are inconsistent and sometimes use alerts.
ACTION: CREATE `public/account/action-contract.js`, `public/account/confirm-dialog.js`, `public/account/toast-log.js`, `docs/internal/account-action-contract.json`, and `scripts/build-account-action-contract.cjs`.
CODE: every action declares method, route, idempotency key policy, confirmation level, destructive flag, required permission, expected duration, optimistic update policy, rollback/undo policy, disabled reasons, success message, error mapping, audit event, telemetry event, and CLI equivalent.
CODE: destructive actions must use accessible modal/dialog semantics, focus trap, escape/cancel, typed confirmation when required, and account-visible audit event id after success.
EXIT: account actions are safe, predictable, keyboard-operable, and traceable.

REDLINE: account tables and data-dense panels are not standardized.
ACTION: CREATE `public/ui/data-table.js`, `public/ui/filter-bar.js`, `public/ui/status-badge.js`, `public/ui/metric-card.js`, and `docs/internal/data-display-contract.json`; WIRE account pages, docs API route tables, benchmark tables, marketplace tables, and logs.
CODE: table contracts must declare columns, sort keys, filter keys, empty rows, loading skeleton dimensions, row actions, bulk actions, responsive priority, keyboard navigation, caption, status badges, timestamps, number formatting, and export behavior.
CODE: lists over 50 rows require pagination or virtualization. Tables must not rely on color alone, must preserve row height under async content, and must expose status text for screen readers.
EXIT: data presentation feels like one enterprise product and remains usable on mobile, keyboard, and screen readers.

REDLINE: docs are broad but not organized as a user-success system.
ACTION: CREATE `docs/internal/docs-ia-contract.json`, `public/docs/docs-index.json`, `public/docs/search-index.json`, `scripts/build-docs-ia.cjs`, and `public/docs/docs-shell.js`; WIRE generated CLI docs, API docs, SDK docs, tutorials, product pages, and account help links.
CODE: every product surface must have one Diataxis set:

```text
tutorial: first successful result
how_to: operational task
reference: API/CLI/SDK exact contract
explanation: architecture, tradeoffs, and scope
```

CODE: docs rows must declare audience, prerequisite, product surface, journey, live code path, API routes, CLI commands, SDK methods, account page, freshness owner, last_verified_at, external-gated claims, and runnable examples.
EXIT: docs guide users from first value to production operation without burying them under fragmented pages.

REDLINE: API docs are not a complete developer product until routes are searchable, executable, authenticated, and tied to SDK examples.
ACTION: CREATE `public/docs/api-explorer.js`, `public/docs/api-search.js`, `docs/internal/api-docs-experience-contract.json`, and `scripts/build-api-docs-experience.cjs`; WIRE OpenAPI, api-routes JSON, SDK examples, account API keys, and docs shell.
CODE: every API operation page must render method/path, auth/security scheme, required plan, request schema, response schema, error/problem variants, idempotency policy, rate limit, tenant/object authorization note, cURL, Node, Python, OpenAI-compatible example when relevant, copy buttons, try-it panel, and account key safety state.
CODE: the try-it panel must never expose secret values in generated snippets, must show selected environment, must preserve request ids, and must explain 401/403/429/5xx next actions.
EXIT: API docs become a conversion and activation surface, not only generated route inventory.

REDLINE: public and docs metadata still need a single search/discovery authority.
ACTION: CREATE `docs/internal/page-metadata-contract.json`, `scripts/build-page-metadata.cjs`, `public/page-metadata.json`, and WIRE sitemap, llms.txt, `.well-known/ai-context.json`, OpenGraph, Twitter cards, JSON-LD, breadcrumbs, and canonical URLs.
CODE: every page declares title, H1, description, canonical URL, robots state, product surface, page type, audience, primary CTA, secondary CTA, schema.org type, image, alt, freshness, and exclusion reason if not indexed.
CODE: titles must be concise and unique; H1/title/og:title must agree on page subject; descriptions must be specific; structured data must use SoftwareApplication/WebApplication/FAQPage/HowTo/BreadcrumbList only where the page actually satisfies the schema.
EXIT: search snippets, social cards, AI discovery files, and page metadata are generated from product truth rather than hand-edited per page.

REDLINE: account and docs performance cannot rely on screenshots alone.
ACTION: CREATE `src/ux/web-vitals-contract.js`, `public/perf/vitals.js`, `docs/internal/performance-budget-contract.json`, and `scripts/build-performance-budget.cjs`; WIRE account shell, docs shell, public shell, media manifest, screenshot audits, and release evidence.
CODE: budgets must cover LCP, INP, CLS, total blocking time, JS bytes by shell/page, CSS bytes by shell/page, image bytes, font loading, third-party scripts, DOM node count, and route-specific critical resources.
CODE: account pages must reserve dimensions for async panels, avoid layout shifts from nav/theme hydration, defer non-critical charts, use skeletons for slow data, and expose degraded/offline states.
EXIT: performance quality is measured as product behavior, not retrofitted with after-the-fact audits.

REDLINE: accessibility fixes are currently runtime repairs and scattered CSS/JS.
ACTION: CREATE `docs/internal/accessibility-contract.json`, `scripts/build-accessibility-contract.cjs`, and `public/ui/a11y-primitives.js`; WIRE nav, account shell, docs shell, forms, tables, dialogs, tabs, disclosures, toasts, copy buttons, charts, media, and demo widgets.
CODE: component contracts must include role, keyboard support, focus behavior, accessible name, target size, status announcements, reduced motion, contrast tokens, heading level, and mobile/touch behavior. WCAG 2.2 target-size, focus appearance, consistent navigation/help, status messages, and input modality requirements must be encoded.
EXIT: accessibility is built into reusable primitives and generated contracts, not patched by `nav.js` after pages load.

### Frontend, Website, And Design Redlines

REDLINE: homepage and public pages carry hidden legacy wave/demo payloads and wordy product framing.
ACTION: REPLACE homepage source with product-proof components tied to the three product surfaces: route/capture, distill/compile, and run/govern.
CODE: first viewport must show one crisp category statement, three concrete product outcomes, one live proof component, one primary CTA, one secondary docs CTA, and no hidden legacy proof paragraphs or wave anchors.
EXIT: a buyer can understand what Kolm does in five seconds and can immediately try or inspect proof.

REDLINE: visual design is fragmented across migration stylesheets and page-local CSS.
ACTION: REPLACE `public/brand-refresh.css`, `public/surface-polish.css`, `public/home-refresh.css`, one-off inline styles, and page-local button/card/nav rules with canonical tokens and components.
CODE: `public/design-tokens.css` owns color, type, spacing, radius, shadow, focus, motion, and state layers; component CSS owns buttons, nav, cards, tables, forms, code blocks, tabs, popovers, modals, toasts, empty states, and account panels.
EXIT: public, docs, and account pages share one enterprise-grade visual system.

REDLINE: navigation is bloated and inconsistent.
ACTION: CREATE `docs/internal/navigation-manifest.json` and WIRE `public/nav.js`, account nav, docs nav, sitemap, breadcrumbs, and page registry to it.
CODE: nav groups must be `Product`, `Docs`, `Pricing`, `Enterprise`, `Customers/Proof`, and `Account`; Product must expose route/capture, distill/compile, and run/govern as the top conceptual split.
EXIT: nav underlines, current states, popouts, mobile disclosures, breadcrumbs, and page-family labels cannot drift.

REDLINE: media and demos are not yet product proof.
ACTION: CREATE `docs/internal/product-proof-media-matrix.json`, `docs/internal/demo-interaction-matrix.json`, and `docs/internal/media-optimization-manifest.json`; WIRE them to homepage, product, pricing, enterprise, docs, and account overview.
CODE: every primary media asset must declare product surface, user value, source file, optimized formats, dimensions/aspect ratio, alt or decorative role, transcript/captions if video, reduced-motion behavior, fallback, load priority, and owning page.
EXIT: media is either proof of real product behavior or it is deleted/archived.

#### UI Implementation Blueprint

CREATE a runtime UI shell instead of page-local behavior:

```text
public/ui/tokens.css
public/ui/components.css
public/ui/shell.js
public/ui/disclosure.js
public/ui/tabs.js
public/ui/toast.js
public/ui/forms.js
public/ui/state-panel.js
public/account/account-shell.js
public/account/account-state.js
public/account/account-actions.js
```

REPLACE page-local nav, button, card, disclosure, popout, table, copy-button, theme, and account-state code with these modules.

CODE: `public/ui/shell.js` owns skip link, current nav state, mobile nav state, focus restoration, escape close, click-outside close, theme hydration, build hash, and page-family hooks. It reads `docs/internal/page-family-contracts.json` through a generated public projection.

CODE: `public/ui/disclosure.js` implements one accessible disclosure primitive for nav popouts, mobile menus, account filters, pricing FAQs, docs sidebars, and detail panels:

```js
createDisclosure({
  button,
  panel,
  closeOnEscape: true,
  closeOnOutsideClick: true,
  restoreFocus: true,
  currentMode: 'aria-expanded',
});
```

CODE: `public/ui/state-panel.js` renders the canonical account/product states: `no_auth`, `loading`, `empty`, `error`, `partial`, `missing_credentials`, `local_only`, `external_gated`, `sample_only`, `production_ready`, `success`, and `disabled`. Every account page and live demo uses this instead of hand-written empty/error copy.

CODE: `public/ui/forms.js` owns labels, validation, field errors, submit disabled/loading/success/error, idempotency key display where relevant, retryability, and request id display. It consumes API problem details and account action contracts.

EXIT: UI polish becomes code. Nav underlines, popout styles, button states, empty states, error states, keyboard behavior, focus rings, and account loading states are implemented once and reused across public, docs, pricing, enterprise, and account surfaces.

#### Product Demo Implementation Blueprint

CREATE a real proof runner instead of marketing-only demo sections:

```text
public/demo/kolm-runner.js
public/demo/code-swap.js
public/demo/artifact-preview.js
public/demo/roi-calculator.js
public/demo/demo-state.js
docs/internal/demo-interaction-matrix.json
```

CODE: `public/demo/kolm-runner.js` accepts a pasted OpenAI-compatible request, redacts secrets client-side before display, sends only the allowed no-auth demo payload to a safe demo endpoint, and returns a `.kolm` artifact preview, not a fake success panel. If the live endpoint is unavailable, it renders `demo_unavailable` with local CLI fallback and no false persistence claim.

CODE: `public/demo/code-swap.js` renders the before/after code comparison for all three product surfaces:

```text
route/capture: raw OpenAI SDK call -> Kolm base URL + owned receipt/capture
distill/compile: repeated model calls -> signed .kolm artifact with eval scope
run/govern: hosted-only inference -> placement decision for local/device/cloud with audit trail
```

CODE: `public/demo/roi-calculator.js` uses plan/billing/provider cost data from canonical manifests, shows assumptions inline, and stores no sensitive spend input unless the user is authenticated and explicitly saves it.

CODE: `public/demo/artifact-preview.js` renders artifact hash, provenance, K-Score scope, eval status, runtime targets, storage state, and next action. It must visually distinguish `sample_only`, `placeholder_eval`, `uncalibrated`, `external_gated`, and `production_ready`.

EXIT: homepage/product/pricing/enterprise/docs demos prove working Kolm behavior and share one state/error/accessibility implementation.

#### Public Surface Implementation Redlines From Manual Use

REFERENCE BASELINE: WCAG 2.2, WAI-ARIA Authoring Practices, Core Web Vitals, Google title/snippet guidance, Schema.org `SoftwareApplication`, Diataxis, and the local UI/UX contract all point to the same implementation requirement: the website must be built from deterministic components and page contracts, not repaired after load by page-local scripts.

REDLINE: `public/nav.js` is doing production UI repair work that should not exist at runtime.
ACTION: SPLIT it into source-owned shell modules and generated manifests:

```text
public/ui/shell.js
public/ui/nav.js
public/ui/theme.js
public/ui/disclosure.js
public/ui/account-shell.js
docs/internal/navigation-manifest.json
docs/internal/page-registry.json
scripts/build-public-shell.cjs
```

CODE: delete runtime CSS injection, `!important` guardrails, heading repair, checkbox/radio wrapping, brand text rewriting, GitHub button deletion, and ad hoc page-family patching from `public/nav.js`. Generated HTML must already contain the right landmarks, headings, labels, button names, nav state, skip link, theme hook, and account shell slot.

CODE: `public/ui/nav.js` owns one active-state algorithm and one disclosure primitive. It must not have contradictory mega-menu comments and mega-menu code in the same file. The implementation must choose either click/tap disclosure or no disclosure; hover-only navigation is forbidden. Current-state underline, focus ring, expanded state, mobile drawer state, and breadcrumb label come from `docs/internal/navigation-manifest.json`.

CODE: every nav item declares `id`, `label`, `href`, `page_family`, `children`, `mobile_behavior`, `requires_auth`, `product_loop`, `seo_priority`, and `breadcrumb_label`. The only top-level public nav groups are Product, Docs, Pricing, Enterprise, Proof, and Account. Product children are exactly the three buyer mental models: route/capture, compile/distill, and run/govern.

EXIT: no public page relies on `nav.js` to correct broken markup after load. View source already contains the final nav, title, active state hooks, skip link, and account entrypoint.

REDLINE: homepage source is carrying legacy wave assets, repeated style systems, mojibake, hidden anchors, and product proof fragments instead of one finished product story.
ACTION: REBUILD `public/index.html` from a homepage content contract and component set:

```text
docs/internal/homepage-product-proof.json
public/home/home-hero.js
public/home/home-proof-runner.js
public/home/home-code-compare.js
public/home/home-roi.js
public/home/home-proof-media.js
public/home/home-social-proof.js
public/home/home.css
scripts/build-homepage.cjs
```

CODE: first viewport must not say abstract category filler like "turn model traffic into owned AI" unless the next seven words concretely explain all three product loops. The hero must state the product in one line, then show three executable outcomes:

```text
Route and capture existing AI API traffic.
Compile and distill task artifacts from top models.
Run governed artifacts on cloud, VPC, local, and device targets.
```

CODE: no hero paragraph may exceed two sentences. No first-screen block may use jargon without a visible proof element beside it. The proof runner, code comparison, ROI calculator, and demo video must share a single `demo_state` model with `ready`, `running`, `artifact_ready`, `demo_unavailable`, `sample_only`, and `needs_auth`.

CODE: homepage may load only the canonical shell CSS, homepage CSS, and proof-runner JS. Remove migration wave sheets and scripts from the critical path unless a source manifest proves they own a live component. Inline CSS is limited to critical token bootstrapping; all product layout CSS lives in `public/home/home.css`.

EXIT: a cold visitor can answer "what is Kolm, who is it for, why now, what can I try" within five seconds without reading a long paragraph.

REDLINE: design tokens exist, but the cascade is still fragmented by `ks.css`, `surface-polish.css`, `frontier.css`, `w687.css`, `w706.css`, `supplement.css`, `warm-paper.css`, and page-local styles.
ACTION: CREATE a CSS cascade authority and retire the migration layer:

```text
docs/internal/css-cascade-contract.json
docs/internal/component-style-registry.json
public/ui/tokens.css
public/ui/base.css
public/ui/components.css
public/ui/layouts.css
public/ui/account.css
public/ui/docs.css
scripts/build-css-cascade.cjs
```

CODE: `public/design-tokens.css` or its successor owns only semantic tokens: color, typography, spacing, radius, border, elevation, focus, state, motion, and z-index. Component files consume tokens and may not define raw brand color values. Page files may not ship page-local button, nav, card, modal, table, form, code-block, tooltip, popover, tab, toast, or account-panel CSS.

CODE: every remaining stylesheet declares `layer`, `owner`, `allowed_selectors`, `forbidden_selectors`, `depends_on`, `loaded_on`, `max_bytes`, and `sunset_condition`. No stylesheet named for a wave, migration, temporary polish pass, or experiment is allowed in production HTML.

CODE: visual density rules are explicit: marketing pages use spacious proof-led sections; account/docs/productivity pages use dense operational layouts; buttons use one primary action per screen; cards are used only for repeated items, modals, and framed tools; page sections are not nested card stacks.

EXIT: all public, docs, pricing, enterprise, product, and account pages render as one designed product without page-specific CSS fights.

REDLINE: account overview is trying to be the product command center, but it is hard-coded while `nav.js` also injects account chrome and the repo has many account pages with no single operational spine.
ACTION: CREATE an account application shell generated from the product matrix:

```text
docs/internal/account-surface-matrix.json
docs/internal/account-navigation-contract.json
docs/internal/account-state-contract.json
public/account/account-shell.js
public/account/account-nav.js
public/account/account-home.js
public/account/product-loop-card.js
public/account/readiness-panel.js
public/account/action-center.js
scripts/build-account-pages.cjs
```

CODE: remove duplicate skip links, stale `Wrapper`/`Studio`/old GitHub nav labels, inline account layout styles, and page-owned sidebar lists from account HTML. The generated account shell owns top nav, sidebar, breadcrumbs, product loop switcher, account status, API key safety state, plan/entitlement state, and cloud/storage readiness.

CODE: account home shows three product loops, not a pile of unrelated feature cards. Each loop card renders current data, missing setup, next action, API route, CLI command, docs page, last proof event, entitlement requirement, and blocking reason. Blocking reasons are constrained to `needs_auth`, `needs_plan`, `needs_api_key`, `needs_credentials`, `needs_storage`, `needs_cloud`, `needs_package_release`, `needs_benchmark_data`, `needs_certification`, `needs_external_partner`, and `ready`.

CODE: every account page consumes `account-state-contract.json` for loading, empty, partial, failed, disabled, dangerous, and success states. Browser alerts are forbidden. Every mutating action uses the action contract: method, route, idempotency, permission, confirmation, retry, undo/rollback, audit event id, telemetry event, and CLI equivalent.

EXIT: post-auth account feels like a production control plane: users can see exactly what is ready, what is blocked by them, what is blocked by Kolm, and what action moves the product forward.

REDLINE: docs are a mixture of generated references, hand-written hubs, stale nav chrome, and page-local command palette behavior.
ACTION: BUILD docs from a Diataxis and product-route registry:

```text
docs/internal/docs-ia-contract.json
docs/internal/docs-route-registry.json
public/docs/docs-shell.js
public/docs/docs-search.js
public/docs/docs-command-palette.js
public/docs/search-index.json
scripts/build-docs-ia.cjs
scripts/build-docs-shell.cjs
```

CODE: every product surface has one tutorial, one how-to, one reference, and one explanation document. Every doc page declares `audience`, `prerequisite`, `product_surface`, `product_loop`, `account_page`, `api_routes`, `cli_commands`, `sdk_methods`, `freshness_owner`, `last_verified_at`, `example_kind`, and `external_scope`.

CODE: docs search and command palette use the same search index. Results are ranked by product loop, activation path, exact command/API match, freshness, and current page context. CLI docs, API docs, SDK docs, tutorials, account help, and product pages cannot each invent their own search/navigation shell.

CODE: API docs become executable developer surfaces. Every operation shows auth scheme, plan/entitlement, request schema, response schema, problem details, idempotency, rate limit, tenant authorization, cURL, Node, Python, OpenAI-compatible variant where relevant, try-it environment, request id, and secret-handling warning.

EXIT: a developer can go from "I have an OpenAI call" to "I compiled and ran a governed artifact" through docs without jumping across disconnected hubs.

REDLINE: pricing is still allowed to drift between marketing copy, JSON-LD, Stripe mappings, account plan UI, CLI billing tiers, and backend plan routes.
ACTION: CREATE a billing/pricing generator with one source of truth:

```text
docs/internal/billing-catalog.json
docs/internal/pricing-page-contract.json
src/billing/catalog.js
public/pricing/pricing-data.json
scripts/build-pricing-surfaces.cjs
```

CODE: public pricing, `/v1/plans`, `/v1/billing/tiers`, Stripe prices, checkout/change-plan actions, account plan cards, upgrade modals, enterprise inquiry copy, docs, CLI billing output, OpenAPI examples, JSON-LD offers, and sales emails all read from the same catalog. If Business is legacy, it is only a compatibility alias and never appears as a live public self-serve plan. If Business is a real public tier, every surface must say so with the same price, limits, entitlement, and support path.

CODE: enterprise cannot look self-serve unless sales checkout is actually implemented. Enterprise CTA goes to inquiry/contact sales, shows procurement/security docs, and declares sales-required state. JSON-LD must not advertise fake prices or fake availability.

EXIT: no buyer, crawler, account user, CLI user, or backend route can see a different pricing model.

REDLINE: media, demo video, screenshots, and proof visuals are treated as decoration instead of evidence.
ACTION: CREATE a product media proof system:

```text
docs/internal/product-proof-media-matrix.json
public/media/media-manifest.json
public/media/video-player.js
public/media/proof-frame.js
scripts/build-media-manifest.cjs
```

CODE: every primary image/video declares product loop, claim supported, source capture, optimized files, width, height, aspect ratio, loading priority, transcript, captions, poster, alt text, dark/light behavior, reduced-motion behavior, fallback, owner, and stale date. A video without a poster, captions, transcript, fallback, and visible product UI is not a product video.

CODE: hero media must show actual Kolm product states: pasted OpenAI call, generated `.kolm` artifact, K-Score/eval scope, runtime target decision, account readiness, or artifact proof. Abstract code rain, generic dashboard cards, and empty video shells are deleted or moved to archive.

EXIT: every above-the-fold visual proves a real product capability.

REDLINE: metadata and discovery files still tolerate mojibake, stale product names, stale pricing, inconsistent schema, and page-specific manual edits.
ACTION: CREATE one metadata authority:

```text
docs/internal/page-metadata-contract.json
public/page-metadata.json
scripts/build-page-metadata.cjs
scripts/build-discovery-files.cjs
```

CODE: every page declares title, H1, description, canonical, robots, page family, product loop, primary CTA, secondary CTA, schema type, image, alt, freshness, sitemap priority, and whether it appears in `llms.txt` or `.well-known/ai-context.json`. Titles must be concise, unique, and subject-specific. Descriptions must be page-specific and human-readable. Schema.org `SoftwareApplication` or `WebApplication` appears only when the page is actually about the application, not as generic site filler.

CODE: mojibake and replacement markers are release-blocking content defects. The generator rejects known bad separator codepoints such as `U+7E5A`, `??kolm`, broken separators, duplicate titles, empty descriptions, repeated descriptions, stale `kolmogorov` brand strings, and public GitHub URLs that point to old repository identity.

EXIT: search snippets, social cards, AI discovery files, browser tabs, breadcrumbs, and structured data all tell the same clean story.

REDLINE: accessibility and performance are being handled as after-the-fact corrections instead of component implementation constraints.
ACTION: BUILD the constraints into component source:

```text
docs/internal/accessibility-contract.json
docs/internal/performance-budget-contract.json
src/ux/web-vitals-contract.js
public/perf/vitals.js
scripts/build-accessibility-contract.cjs
scripts/build-performance-budget.cjs
```

CODE: every component declares role, accessible name source, keyboard model, focus entry, focus exit, focus ring token, target size, pointer/touch behavior, status announcement, reduced-motion behavior, contrast token, loading skeleton dimensions, and error announcement. Use WAI-ARIA APG patterns for custom widgets and native HTML controls where possible.

CODE: every route declares LCP element, critical CSS budget, JS budget, image budget, font budget, CLS risk elements, INP-critical handlers, deferred scripts, third-party scripts, and offline/degraded state. Homepage and account shell must reserve dimensions for hero media, demo runner, auth status, account metrics, and async readiness panels before data arrives.

EXIT: the product cannot regress into broken focus, cramped targets, invisible state changes, layout jumps, or slow input because those constraints live in the modules that render the UI.

REDLINE: manual product use is not encoded as a buildable redline.
ACTION: CREATE a human-use script that implementation agents must actually perform while building, not after claiming done:

```text
docs/internal/manual-product-use-redline.md
docs/internal/manual-product-use-scenarios.json
```

CODE: the minimum manual scenarios are: anonymous homepage five-second read, paste OpenAI request into demo, compare before/after code, run ROI calculator, watch/read demo video fallback, open pricing and enterprise, search docs for "OpenAI", execute API try-it with a safe key, sign in, open account overview, generate/rotate/revoke key, view storage readiness, view product graph/readiness closeout, open CLI docs, open API reference, open mobile nav, use keyboard-only nav, and use dark/light mode. Each scenario records the exact page, expected visible state, expected next action, and failure text.

EXIT: implementation work is judged by whether the product can actually be used end to end, not by whether a scanner says the page rendered.

### Build, Release, And Source Boundary Redlines

REDLINE: the repo cannot distinguish source, generated output, archive, local state, reports, cache, fixtures, and release artifacts strongly enough.
ACTION: CREATE `scripts/build-source-boundary-manifest.cjs` and `docs/internal/source-boundary-manifest.json`.
CODE: every path class must declare allowed location, release inclusion, git inclusion, generator, retention, sensitivity, and cleanup action. Build outputs, caches, backups, temp files, logs, local databases, and stale screenshots must be moved, ignored, or deleted.
EXIT: release source contains no accidental runtime state or generated sprawl.

REDLINE: generator order can race or silently drift.
ACTION: CREATE `scripts/build-build-graph.cjs`, `docs/internal/build-graph.json`, `docs/internal/generator-registry.json`, `docs/internal/generated-artifact-manifest.json`, and `docs/internal/report-retention-manifest.json`.
CODE: every writing script declares inputs, outputs, ordering, idempotence, check mode, owner, release inclusion, and forbidden paths. API docs must precede OpenAPI. Page registry must precede sitemap/metadata/AI context. Product graph must precede readiness/claim/account redlines.
EXIT: `build:all` and release verification run from one deterministic DAG.

REDLINE: release verification is split across many partial authorities.
ACTION: CREATE `scripts/build-final-redline.cjs` and `reports/build-redline/final-build-redline.json`.
CODE: final redline aggregates source boundary, generated artifacts, route contracts, API security, idempotency, account matrix, account shell, design system, page registry, media proof, brand/package identity, SDK state, worker/runtime matrices, claim scope, production evidence, and worktree cleanliness.
EXIT: release has one decision artifact and cannot pass while any implementation redline remains open.

#### Codebase Completion And Build-Redline Implementation Blueprint

REDLINE: "tests passed" is not the same as "the codebase is finished."
ACTION: CREATE `src/build/completion-contract.js`, `scripts/build-completion-redline.cjs`, `docs/internal/codebase-completion-contract.json`, and `reports/build-redline/completion-redline.json`; WIRE release verification, codebase file ledger, codegraph, route docs, product graph, generated artifact manifest, package release matrix, source-boundary manifest, claim-scope gate, and local/prod surface smoke.
CODE: completion state is computed from code and artifacts, not opinions:

```json
{
  "release_id": "kolm-0.2.6+<commit>",
  "source_ok": true,
  "generated_ok": true,
  "routes_ok": true,
  "docs_ok": true,
  "packages_ok": true,
  "runtime_ok": true,
  "security_ok": true,
  "ui_ok": true,
  "external_gates": ["package_release", "certification", "public_benchmark"],
  "blocking_redlines": [],
  "allowed_external_redlines": []
}
```

EXIT: a build can only be called finished when every local redline is closed and every non-local redline is explicitly external, named, owner-assigned, and hidden from shipped claims.

REDLINE: stub, mock, placeholder, demo, sample, synthetic, fixture, preview, and external-gated paths are all mixed together in source comments and runtime behavior.
ACTION: CREATE `src/build/simulation-boundary.js`, `docs/internal/simulation-boundary-registry.json`, `scripts/build-simulation-boundary.cjs`, and `tests/build-simulation-boundary.test.js`; WIRE compile, distill, bakeoff, confidential compute, cloud distill, redaction benchmarks, live demo runner, screenshot tooling, product frontier simulators, and generated changelog/docs.
CODE: every non-production behavior must declare one of:

```text
test_fixture
deterministic_local_simulation
sample_content
demo_only
external_proof_missing
package_release_missing
certification_missing
legacy_migration
production_blocked
```

CODE: each row declares source path, exported symbol or route, allowed environments, user-visible label, production behavior, account/docs copy, test owner, replacement implementation, and sunset condition. Production code may import simulations only through an explicit `allowSimulation` decision that defaults false.
EXIT: the codebase never accidentally promotes a deterministic simulation, sample fixture, shape-only verifier, or demo path into production-ready product behavior.

REDLINE: route handlers, OpenAPI, API reference, SDK examples, account calls, CLI/TUI commands, and product-surface probes still rely on separate generation scripts.
ACTION: CREATE `src/build/route-source-authority.js`, `docs/internal/route-source-authority.json`, and `scripts/build-route-authority.cjs`; WIRE `src/router.js`, route comments, API ref, OpenAPI, SDK generation, account fetch wrappers, CLI route helpers, product surfaces, smoke probes, and changelog route claims.
CODE: route authority rows must include method, path, group, auth mode, plan gate, tenant-object policy, idempotency policy, request schema, response schema, error envelope, SDK method, CLI equivalent, account caller, docs page, smoke probe, and external dependency. API docs and OpenAPI are generated from these rows, not from loosely parsed comments.
EXIT: adding or changing a route forces API docs, SDK affordances, smoke tests, account states, and product ownership to move together.

REDLINE: there are too many generator scripts, and their write order can corrupt or stale outputs when agents run concurrently.
ACTION: CREATE `scripts/build-all.cjs`, `src/build/build-dag.js`, `docs/internal/build-dag.json`, and `docs/internal/generated-artifact-lock.json`; REPLACE script-to-script assumptions with a lock-aware DAG executor.
CODE: every writing script declares input globs, output paths, check command, write lock, stale detection, dependency scripts, max runtime, idempotence, and owner. The DAG executor refuses to run two writers for the same output, writes to temp files, validates parseability, then atomically replaces outputs.
CODE: required ordering includes codebase file ledger before final redline, route authority before API ref, API ref before OpenAPI, page registry before sitemap and AI context, product graph before readiness closeout/account graph, package matrix before install docs, design cascade before public page builds, and media proof before homepage/product renders.
EXIT: concurrent agents cannot break generated API docs, product graph, OpenAPI, page metadata, or public docs through write races.

REDLINE: source-boundary cleanup is not complete until local state, generated reports, screenshots, test caches, build artifacts, package outputs, and internal research files have enforceable destinations.
ACTION: CREATE `src/build/source-boundary-policy.js`, `docs/internal/source-boundary-policy.json`, `scripts/enforce-source-boundary.cjs`, and `scripts/clean-managed-artifacts.cjs`; WIRE `.gitignore`, `.vercelignore`, npm `files`, Docker contexts, Vercel/Railway deploy, file ledger, release verify, and CI.
CODE: every path pattern must be one of `release_source`, `public_static`, `generated_public`, `generated_internal`, `internal_docs`, `test_fixture`, `local_runtime_state`, `report`, `screenshot_evidence`, `package_output`, `cache`, `scratch`, or `forbidden`. Forbidden files include `.env*`, raw credentials, local SQLite prod copies, WAL/SHM, ad hoc `.tmp`/`.bak`, root screenshots, secret-bearing reports, and internal redline docs in deploy contexts.
EXIT: `git status`, deploy contexts, npm packages, Docker images, and public static output contain only intentional artifacts.

REDLINE: "kolmogorov" to "kolm" cannot be handled as a blind text replacement.
ACTION: CREATE `src/build/brand-namespace-policy.js`, `docs/internal/brand-namespace-migration.json`, and `scripts/enforce-brand-namespace.cjs`; WIRE public copy, package names, route ids, env vars, local directories, historical archives, changelog, license/legal entities, analytics, docs, and code comments.
CODE: the migration policy must classify every remaining legacy token as `must_rename`, `historical_archive_allowed`, `legal_entity_allowed`, `compat_alias_allowed`, or `forbidden`. Renames must include file path, symbol, public URL, package id, env var, migration behavior, redirect/alias, and sunset date.
EXIT: the codebase becomes Kolm without breaking compatibility aliases or falsifying historical archive records.

REDLINE: full release verification is long, mutable, and hard to use as a build-redline for implementation agents.
ACTION: SPLIT `scripts/release-verify.cjs` into `src/build/release-gates.js`, `src/build/gate-runner.js`, `src/build/gate-result.js`, and `scripts/release-verify.cjs` as a thin CLI wrapper; CREATE `docs/internal/release-gate-registry.json`.
CODE: every gate declares name, owner, command, timeout, dependencies, required environment, writes, reads, pass parser, failure parser, artifact outputs, retryability, local/prod applicability, and remediation doc. Gate results are saved as JSON with command, exit status, duration, stdout/stderr tail, semantic checks, and evidence paths.
EXIT: build failures are implementation work orders with exact owner and repair path, not a long terminal transcript.

REDLINE: the current codegraph knows files/routes/symbols but not product completion responsibility.
ACTION: EXTEND `src/repo-codegraph.js` and `scripts/build-codegraph.mjs` into a product-aware graph that records imports, exports, route ownership, docs ownership, generated outputs, tests, scripts, packages, public pages, account pages, and wave ownership.
CODE: each node must include `kind`, `owner`, `product_surface`, `journey`, `release_included`, `generated_by`, `tests`, `docs`, `routes`, `api_schema`, `account_pages`, `public_pages`, `external_dependencies`, `simulation_boundary`, and `open_redlines`.
EXIT: an implementation agent can open one graph row and know exactly what code, docs, tests, product surface, and release gate must change together.

REDLINE: screenshots, UI audits, SEO sweeps, API docs, and product proofs produce evidence but are not tied into one release bundle.
ACTION: CREATE `src/build/evidence-index.js`, `scripts/build-release-evidence-index.cjs`, and `reports/releases/<release-id>/evidence-index.json`; WIRE screenshot reports, UI surface audits, local/prod surface smokes, API route docs, OpenAPI, product graph, readiness closeout, package matrix, security red team, benchmark evidence, and compliance packets.
CODE: every evidence item declares path, type, produced_by, release_id, timestamp, source commit, target environment, routes covered, product surfaces covered, pass/fail/warn counts, external blockers, retention, public/customer/internal visibility, and hash.
EXIT: "we verified it" always points to a durable release evidence index instead of scattered reports.

REDLINE: implementation waves are becoming the product architecture, but duplicates and superseded waves still create ambiguity.
ACTION: CREATE `src/build/wave-resolution.js`, `docs/internal/wave-resolution-map.json`, and `scripts/build-wave-resolution.cjs`; WIRE product graph, invention portfolio, frontier contracts, changelog, roadmap docs, and final redline.
CODE: every wave id must resolve to canonical status: `canonical`, `superseded_by`, `merged_into`, `deprecated`, `external_gated`, or `shipped`. Superseded waves must link to their replacement and cannot keep public-facing claims unless the canonical wave owns the implementation.
EXIT: W707-W835 and future waves become an executable architecture tree, not a backlog that duplicates itself.

REDLINE: product code completion is not visible from account, CLI, API, or docs as a single build state.
ACTION: CREATE `/v1/build/redline`, `kolm build redline --json`, `public/account/build-readiness.html`, and `public/docs/build-redline.html` backed by `reports/build-redline/final-build-redline.json`.
CODE: the public-safe API returns release id, local completion status, external gates, product-surface completion, route/docs/package/security/UI coverage, and next required implementation work without leaking internal file paths or secrets. Authenticated account view includes owner, evidence, and repair commands.
EXIT: anyone on the team can see what remains before ship from product UI, CLI, and API, with one source of truth.

#### Directory-Level Codebase Implementation Redlines

CURRENT CUT: raw file enumeration still shows a repo that mixes product source, generated output, build caches, screenshots, package artifacts, local runtime data, and research state. The existing codebase file ledger is useful, but it only covers a filtered release-relevant slice. The finished codebase needs a directory authority that can classify the whole tree, then produce release views for git, npm, Vercel, Docker, Railway, customer evidence, and internal work.

REDLINE: top-level directories do not yet have one enforceable product role.
ACTION: CREATE `docs/internal/directory-authority.json`, `src/build/directory-authority.js`, and `scripts/build-directory-authority.cjs`; WIRE file ledger, source-boundary policy, `.gitignore`, `.vercelignore`, npm package `files`, Docker context, CI artifacts, release evidence, and final redline.
CODE: every top-level path declares `kind`, `runtime`, `release_role`, `git_policy`, `deploy_policy`, `package_policy`, `generated_by`, `owner`, `product_surface`, `evidence_visibility`, `retention_days`, `clean_command`, and `forbidden_children`. Unknown top-level files fail the directory authority unless explicitly classified.

Directory authority must start with this implementation map:

| path family | runtime role | implementation redline | finished exit |
|---|---|---|---|
| `src/` | Node backend/product kernel | Split monolithic route and product modules into owned domains with route authority, problem details, tenant authorization, idempotency, and product graph links. | Every exported backend capability has API/CLI/account/docs/test ownership or is internal-only. |
| `server.js` and `api/` | HTTP entrypoints | Generate route collision rules, security headers, CSP exceptions, Vercel function wrappers, Railway/direct server parity, health/readiness, and static route rewrites from one deploy topology contract. | Local, Vercel, Railway, and Docker entrypoints serve the same canonical route map with explicit differences. |
| `cli/` | operator and developer command surface | Decompose the large CLI into command modules that read product graph, route authority, package identity, and readiness state. | Each command has help, examples, JSON schema, exit codes, stderr policy, docs page, and account/API equivalent. |
| `public/` | shipped web product | Generate public pages from page registry, metadata authority, design system, media proof, nav contract, pricing catalog, docs IA, and account shell. | No public HTML depends on runtime repair scripts, stale metadata, page-local nav, or hidden wave artifacts. |
| `public/account/` | post-auth product console | Generate account pages from account surface matrix and action/state contracts. | Every account control has permission, API route, state, error, audit, telemetry, keyboard, and docs ownership. |
| `public/docs/` | developer activation surface | Generate docs shell, search, API explorer, CLI docs, SDK examples, and product tutorials from docs IA and route authority. | Docs are executable enough to onboard a developer through route/capture, compile/distill, and run/govern without stale package names. |
| `apps/` | Python product runtime surfaces | Give each app a `pyproject.toml` or package contract, CLI entrypoint, env schema, artifact I/O boundary, smoke command, and docs owner. | Capture/data/eval/export/import/runtime/trainer/showcase apps can be installed, invoked, and diagnosed outside the root Node process. |
| `workers/` | long-running or heavy compute services | Normalize worker command surfaces to doctor, run, smoke, package, container, health, metrics, and failure JSON. | Quantize/distill/compile/runtime/multimodal workers are either production services or explicitly labs/reference code. |
| `services/` | integration services | Classify MCP and side services as production, preview, or internal; add auth, rate limit, lifecycle, package, and observability contract. | Services are deployable and documented or excluded from release claims. |
| `sdk/` | language SDKs and generated clients | Separate source from build outputs, normalize package names, generate examples from route authority, and add per-language build/test/package evidence. | Node, Python, MCP, VS Code, C, Rust, Swift, Kotlin, RN, and browser SDK surfaces have explicit publish or local-source status. |
| `packages/` | publishable npm/local packages | Generate package identity matrix, `files`, provenance, smoke install, readme, and changelog from one package registry. | Every package is publishable, intentionally private, or explicitly not a product claim. |
| `scripts/` | build, release, migration, evidence machinery | Convert one-off `fix-*`, `inject-*`, screenshot, archive, and generated-file writers into idempotent DAG nodes or retire them. | No script writes release artifacts unless registered with inputs, outputs, lock, owner, check mode, and retention. |
| `.github/` | distribution and release automation | Add explicit permissions, concurrency, OIDC/provenance policy, action pinning, secret handling, shell safety, and artifact retention. | Workflows are secure release code, not background automation. |
| `infra/`, `Dockerfile`, `vercel.json`, `railway.toml` | deploy topology | Generate deploy include/exclude, env requirements, route topology, health checks, rollback, and runtime limits from deploy contract. | Deploy config cannot drift from route authority, source boundary, or secret policy. |
| `tests/`, `test/`, `qa/`, `bench/` | verification and benchmark source | Classify tests as unit, contract, smoke, integration, benchmark, fixture, or product evidence; connect each to product surfaces and redlines. | Tests prove specific requirements and do not become the definition of completion by themselves. |
| `docs/internal/` | machine-readable control state | Promote missing ledgers: directory authority, source boundary, build DAG, generator registry, generated artifacts, brand/package, route authority, account matrix, page registry, release gates, and final redline. | Internal JSON is the control plane for build completion, not an unserved side folder. |
| `docs/research/` | implementation planning and redlines | Keep research out of deploy bundles; only promote work into code via explicit implementation rows. | Research cannot masquerade as shipped capability; promoted items have owners, files, and exit conditions. |
| `data/`, `.kolm-bundle/`, `.shots/`, `.ui-debug/`, `reports/`, `tmp*`, `.tmp*` | local state, evidence, caches, scratch | Move live state and bulky generated artifacts behind managed retention and ignore rules; never include them in release source or deploy contexts. | Local state is recoverable, cleanable, non-secret, and never confused with product code. |

EXIT: `scripts/build-directory-authority.cjs --check` proves every path family has a role before any release gate can claim the repo is clean.

REDLINE: `.gitignore` and `.vercelignore` are currently hand-maintained policy files, while source-boundary rules live separately in scripts and comments.
ACTION: GENERATE ignore/deploy-exclude files from `docs/internal/source-boundary-policy.json`.
CODE: the policy emits `.gitignore.generated`, `.vercelignore.generated`, `.dockerignore.generated`, package `files` previews, and a drift report against the committed files. Humans may add comments, but path rules must come from the source-boundary authority.
CODE: deny patterns include env files, credentials, local SQLite/WAL/SHM, root Windows-path scratch files, `.bak`, `.tmp`, test TAP output, local OCR/model downloads, old report folders, screenshot folders, Rust/Python build targets, npm caches, package-release caches, and internal redline docs in public deploys.
EXIT: release exclusion behavior is not a memory exercise. Git, Vercel, Docker, npm, and evidence bundles consume the same boundary.

REDLINE: source and generated output are still mixed inside `public/`, `sdk/`, `workers/`, and root package folders.
ACTION: CREATE `docs/internal/generated-artifact-authority.json`, `src/build/generated-artifact-authority.js`, and `scripts/build-generated-artifact-authority.cjs`.
CODE: every generated file declares source generator, source inputs, output path, stable sort policy, timestamp policy, parser compatibility, hash, release inclusion, and stale handling. Generated JSON must parse with Node and one non-Node parser. Generated HTML must have metadata, main landmark, title, canonical URL, and page-family owner.
CODE: source directories may contain generated files only if a `.generated.json` manifest beside the output declares why colocating is required. Otherwise generated output moves under a generated subtree or is created during release packaging.
EXIT: implementation agents can tell whether a file should be edited directly, regenerated, deleted, or moved.

REDLINE: `sdk/` currently behaves like a source tree and a build-output cache at the same time.
ACTION: CREATE `docs/internal/sdk-package-matrix.json`, `scripts/build-sdk-package-matrix.cjs`, and per-language package contracts.
CODE: each SDK row declares package name, language, source root, generated root, build output root, ignored output root, package manager, build command, test command, smoke install command, publish channel, provenance mode, docs install command, owner, and current release state.
CODE: Rust/C/native targets, Python `__pycache__`, package dist folders, vendored binaries, and generated clients must never sit unclassified in the SDK tree. If an output is intentionally committed, it must have a package reason, hash, and release test.
EXIT: SDKs are a product surface with installable or honestly local-source status, not a pile of mixed artifacts.

REDLINE: `apps/` and `workers/` carry the core compile/distill/run-anywhere promise but are not yet governed like production services.
ACTION: CREATE `docs/internal/runtime-service-matrix.json`, `src/runtime/service-contract.js`, and `scripts/build-runtime-service-matrix.cjs`.
CODE: each app/worker declares language, entrypoint, dependency lock, GPU/CPU requirements, input artifact schema, output artifact schema, env vars, secret vars, storage needs, queue model, health endpoint or doctor command, metrics, logs, timeout, memory/GPU limits, retry policy, cancellation, cleanup, package/container target, and local smoke.
CODE: heavy ML services must fail closed when toolchains, CUDA, model files, provider credentials, or storage credentials are missing. They must return typed readiness problems rather than stack traces or silent local fallbacks.
EXIT: "compile", "distill", "quantize", "runtime-build", "vision/audio/video tokenize", "TSAC", and "ITKV" each have runnable service contracts or are explicitly non-production.

REDLINE: `src/router.js` is still too central to be the long-term authority for hundreds of operations.
ACTION: CREATE `src/routes/` domain modules and migrate route ownership in batches:

```text
src/routes/account.js
src/routes/capture.js
src/routes/distill.js
src/routes/artifacts.js
src/routes/runtime.js
src/routes/registry.js
src/routes/governance.js
src/routes/billing.js
src/routes/deployment.js
src/routes/public.js
```

CODE: `src/router.js` becomes composition only: middleware, shared limits, route module registration, static helper routes, and final error bridge. Each route module exports `routes`, `schemas`, `authz`, `smoke`, and `docs` metadata consumed by route authority and OpenAPI.
CODE: direct `res.status(...).json({ error: ... })` paths are replaced by the canonical RFC 9457 problem bridge. Mutations must declare idempotency handling. Object routes must declare tenant/object authorization. Upstream calls must declare timeout, retry, SSRF boundary, and response redaction.
EXIT: route count can grow without turning the backend into a monolith that only generated docs can understand.

REDLINE: package, deploy, and release provenance are not yet source-to-output complete.
ACTION: CREATE `docs/internal/provenance-authority.json`, `src/release/provenance.js`, and `scripts/build-provenance-authority.cjs`; WIRE SLSA, SPDX, package release, Docker, Vercel/Railway deploy, generated docs, worker images, SDK packages, and final evidence index.
CODE: every release artifact declares source commit, clean/dirty status, build command, builder identity, input hashes, output hash, package name/version, SBOM path, provenance attestation path, signing status, upload/publish target, and verification command.
CODE: SPDX or CycloneDX SBOM generation must cover root app, CLI, SDK packages, worker packages, Docker images, and any bundled native/python/runtime assets. VEX/vulnerability status must be explicit for known vulnerabilities.
EXIT: customers can trace a shipped file, package, image, docs bundle, API spec, or artifact example back to code and build evidence.

REDLINE: current release verification can pass local code paths while production deploy context and bundle contents remain implicit.
ACTION: CREATE `scripts/build-deploy-context-report.cjs` and `docs/internal/deploy-context-report.json`.
CODE: the report computes what Vercel, Railway, Docker, npm packages, and public static hosting will actually include. It compares include/exclude decisions against directory authority, secret policy, source-boundary policy, route authority, and public page registry.
CODE: production deployment is blocked if deploy bundles include internal docs, local state, report folders, screenshot folders, env files, raw test outputs, stale archives, or generated files without generator evidence.
EXIT: "deployable" means the shipped context is known, minimal, secret-clean, and consistent with the product route/page registry.

REDLINE: manual implementation agents have no atomic work package for cleaning a directory without breaking parallel work.
ACTION: ADD `docs/internal/source-cleanup-workorders.json` generated from directory authority and final redline.
CODE: each workorder contains directory, exact paths, ownership, allowed operations, forbidden operations, expected generated replacements, commands to run after, user-visible impact, and merge-conflict rule. Workorders must be disjoint by write set so parallel agents do not corrupt generated files.
EXIT: cleanup moves from broad "clean git" requests to safe, atomic directory work that can be executed and reviewed.

#### CI, Package, And Provenance Implementation Blueprint

REDLINE: GitHub workflows and composite actions are product distribution code, but they are not governed by one secure release contract.
ACTION: CREATE `src/release/ci-contract.js`, `scripts/build-ci-hardening-report.cjs`, and `docs/internal/ci-hardening-report.json`; WIRE `.github/workflows/*.yml`, `.github/actions/*/action.yml`, package release scripts, and final redline to that contract.
CODE: every workflow job must declare owner, trigger, read/write permissions, secret exposure, environment, concurrency group, OIDC use, artifact outputs, cache policy, untrusted input policy, third-party action pins, and release impact. Every composite action must declare inputs, shell safety rules, secret handling, output contract, install source, and versioning strategy.
EXIT: a workflow cannot publish, upload, deploy, or touch secrets unless its job-level permissions, environment, provenance, and action pins are explicit.

REDLINE: local composite actions still install Kolm through old repository paths and mutable source references.
ACTION: REPLACE `npm i -g github:sneaky-hippo/kolm-stack` and similar action install fallbacks with the canonical package identity matrix.
CODE: `.github/actions/kolm-compile/action.yml`, `kolm-test/action.yml`, `kolm-verify/action.yml`, and `kolm-publish/action.yml` must install from one of: pinned release package, local checkout path, or source-preview path that is explicitly marked not for external production. Each action must fail when asked to install from an unapproved legacy repo URL.
EXIT: GitHub Actions users do not execute stale Kolmogorov repo code or mutable unreviewed package sources.

REDLINE: npm, PyPI, Cargo, VS Code, React Native, worker, winget, Docker, and SDK packages have no single publication state machine.
ACTION: CREATE `src/release/package-state.js`, `scripts/build-package-release-matrix.cjs`, and `docs/internal/package-release-matrix.json`; WIRE package docs, API examples, SDK pages, install docs, release workflows, and package manifests to it.
CODE: every package row must include:

```json
{
  "name": "@kolm/sdk",
  "ecosystem": "npm|pypi|cargo|vscode|winget|docker|source",
  "path": "packages/sdk-ts",
  "status": "published|source_preview|private_internal|deprecated_alias|not_shipped",
  "version": "0.2.6",
  "canonical_install": "npm install @kolm/sdk",
  "build_command": "npm run build",
  "test_command": "npm test",
  "pack_command": "npm pack --dry-run",
  "publish_command": "npm publish --provenance",
  "trusted_publisher": true,
  "provenance_required": true,
  "files_allowlist": ["dist", "README.md", "package.json"],
  "docs_pages": ["/docs/sdk"],
  "owner": "sdk-platform"
}
```

EXIT: docs never imply a package manager install path unless that package is publishable, tested, and represented in the package release matrix.

REDLINE: package provenance is not finished until the release can prove what source and workflow produced each artifact.
ACTION: CREATE `src/release/provenance.js`, `docs/internal/provenance-policy.json`, and `reports/releases/<release-id>/provenance-index.json`.
CODE: npm packages use trusted publishing or `npm publish --provenance`; PyPI packages use trusted publishing/OIDC; Docker images record digest, base image digest, SBOM, build args, and source commit; Cargo/VS Code/winget releases record checksums and source commit. Each published artifact records SLSA predicate URI, builder id, build type, external parameters, resolved dependencies, subject digest, and verification command.
EXIT: an enterprise customer can trace public packages, Docker images, CLI installs, worker images, and generated docs back to source and workflow.

REDLINE: workflow dependency and action references are mutable.
ACTION: REPLACE third-party action tags with pinned full-length commit SHAs or approved first-party actions behind an exception file.
CODE: `docs/internal/ci-hardening-report.json` must list every `uses:` entry with owner/repo/ref, whether it is first-party/local/third-party, whether it is pinned to SHA, whether Dependabot can update it, and the allowed exception reason. Local actions still require input validation and shell quoting.
EXIT: a compromised mutable action tag cannot silently change Kolm CI/CD behavior.

REDLINE: workflow token permissions are inconsistent.
ACTION: ADD top-level `permissions: contents: read` to read-only workflows and job-level permissions only where needed.
CODE: release jobs that need OIDC use `id-token: write`; GitHub release jobs use `contents: write`; PR/comment jobs use the narrowest possible permissions; secrets are never passed to pull-request code from forks.
EXIT: the default `GITHUB_TOKEN` blast radius is read-only unless the job contract proves otherwise.

REDLINE: package and release docs are not tied to package states.
ACTION: WIRE `docs/internal/package-release-matrix.json` into `public/docs/quickstart/*`, `public/docs/sdk/*`, cookbooks, CLI help snippets, API docs SDK examples, marketplace import docs, and account SDK/download pages.
CODE: generated docs choose copy from package state:

```text
published -> show package-manager install command and version.
source_preview -> show local checkout/source install with warning.
private_internal -> hide from public docs and show internal owner only.
deprecated_alias -> show migration command and sunset date.
not_shipped -> do not render install instructions.
```

EXIT: install docs cannot drift from package reality.

REDLINE: Docker, Vercel, Railway, and worker deploys do not share a topology contract.
ACTION: CREATE `src/release/deploy-topology.js`, `scripts/build-deploy-topology.cjs`, and `docs/internal/deploy-topology.json`; WIRE `Dockerfile`, `workers/compile-server/Dockerfile`, Helm charts, `vercel.json`, `.vercelignore`, `railway.toml`, and production evidence to it.
CODE: every deploy target declares runtime, image/source, build command, start command, healthcheck, readiness route, secrets, env vars, storage dependencies, network egress, regions, release include/exclude rules, rollback, telemetry, and smoke path.
EXIT: deployment is a governed product surface, not a pile of config files.

#### Deployment, Runtime, Storage, And Operations Execution Blueprint

REDLINE: deployment configuration is currently thinner than the product promise. `vercel.json` is mostly route/redirect/static behavior, `railway.toml` declares a start command and one health path, and the root `Dockerfile` is a simple Node image that copies the whole repository. That does not prove Kolm can safely run the gateway, compiler, storage, workers, account, docs, and runtime surfaces in production.
ACTION: CREATE `docs/internal/deployment-target-matrix.json`, `src/release/deployment-targets.js`, `scripts/build-deployment-target-matrix.cjs`, and `tests/deployment-target-matrix.test.js`; WIRE Vercel static/app deploy, Railway app deploy, Docker app image, compile-server worker image, trainer image, Helm chart, AWS Marketplace stack, and BYOC docs to this matrix.
CODE: each target row must declare `target_id`, `target_kind`, `entrypoint`, `build_command`, `start_command`, `runtime`, `node_version`, `python_version`, `container_base_digest`, `ports`, `health_path`, `ready_path`, `deep_ready_path`, `static_root`, `server_routes`, `worker_routes`, `required_env`, `optional_env`, `secret_refs`, `object_storage`, `persistent_storage`, `egress_allowlist`, `resource_limits`, `autoscaling`, `rollback`, `traffic_cutover`, `smoke_command`, `prod_smoke_command`, and `release_include_exclude_report`.
EXIT: every deployable surface can answer what it runs, what it needs, how it proves readiness, what it excludes, and how to roll back.

REDLINE: environment variables are not a production contract if they live only in code comments and ad hoc readiness checks. Platform limits and redeploy behavior matter: hosted platforms apply env changes per deployment, and local `.env` files must never become release artifacts.
ACTION: CREATE `docs/internal/environment-contract.json`, `src/env/env-contract.js`, `scripts/build-environment-contract.cjs`, and `public/account/environment-readiness.html`; WIRE `src/env.js`, `src/platform-capabilities.js`, `src/object-storage.js`, `src/otel.js`, billing, providers, SSO/SCIM, storage, workers, Docker, Vercel, Railway, and local CLI doctor.
CODE: every env var row must declare `name`, `purpose`, `sensitivity`, `required_in`, `optional_in`, `default_behavior`, `empty_value_behavior`, `max_size_notes`, `rotation_policy`, `owner`, `used_by_files`, `docs_url`, `account_readiness_label`, `secret_value_exposure`, `redeploy_required`, and `production_blocker`.
CODE: env readiness must group variables by product surface: gateway providers, artifact storage, distill/compile workers, object storage, billing, telemetry, SSO/SCIM, email, security keys, deployment, and marketplace.
EXIT: local doctor, account readiness, deployment docs, and production smoke report the same missing/configured env state without exposing secret values.

REDLINE: object storage readiness now detects local, R2 REST, R2 S3-compatible, AWS S3, generic S3, and Supabase S3, but storage is not finished until integrity, multipart behavior, lifecycle, encryption, retention, and failure recovery are first-class.
ACTION: CREATE `src/storage/object-contract.js`, `src/storage/object-integrity.js`, `src/storage/object-lifecycle.js`, `docs/internal/object-storage-contract.json`, and `tests/object-storage-integrity-contract.test.js`; MIGRATE `src/object-storage.js` behind this contract.
CODE: every provider row must declare supported operations, unsupported operations, max single-object size, multipart strategy, checksum algorithms, server-side encryption behavior, conditional write support, range-read support, object-lock support, lifecycle/retention support, delete semantics, public URL behavior, signed URL behavior, retry policy, and data residency caveats.
CODE: artifact writes must store `sha256`, size, content type, artifact id, provenance id, tenant id, storage provider id, bucket, key, etag, checksum header, encryption mode, write receipt, readback result, and deletion policy. Large artifacts must use provider-appropriate multipart or blocked state instead of silent failure.
EXIT: artifact storage can prove write/read/head/delete/list, checksum verification, max-size handling, and secret-safe readiness for every configured provider.

REDLINE: deploy smoke is local-heavy and not enough to say production is healthy after `vercel --prod`, Railway deploy, Docker run, or Helm install.
ACTION: CREATE `scripts/prod-smoke.cjs`, `src/release/prod-smoke-contract.js`, `docs/internal/production-smoke-contract.json`, and `reports/deployments/<release-id>/production-smoke.json`; WIRE production account pages, public pages, API routes, OpenAPI, product graph, storage readiness, billing tiers, provider readiness, auth/session, and artifact verification.
CODE: production smoke must declare target base URL, release id, route list, auth mode, allowed destructive actions, required secrets absent from report, expected status, expected schema, max latency, screenshot requirement, account state requirement, storage/provider readiness expectation, and rollback trigger.
CODE: production smoke must include at least one public page, one docs page, one OpenAPI fetch, one API envelope, one account auth path, one object-storage readiness path, one billing/pricing path, one product graph path, and one artifact verification path. Cloud-specific checks can be `external_gated` only when the environment contract proves the provider is not configured.
EXIT: "deployed" means a production evidence file proves the deployed URL, release id, routes, schemas, readiness, and account behavior.

REDLINE: container images are not finished while they copy the whole repository and rely on runtime exclusion rules to protect internal docs, local data, caches, node_modules, reports, screenshots, and bytecode.
ACTION: REPLACE image builds with `src/release/container-context.js`, `docs/internal/container-context-manifest.json`, and multi-stage Docker contexts for app, compile server, trainer, and runtime workers.
CODE: each image build must use a generated context allowlist from the source-boundary manifest, a pinned base image digest, lockfile install, non-root runtime user, explicit writable directories, no `.env*`, no local `data/`, no `reports/`, no `screenshots/`, no Python `__pycache__`, no nested `node_modules` outside package install, no internal redline docs, and no generated archive snapshots.
CODE: OCI labels must include source commit, release id, package version, OpenAPI version, product graph version, build timestamp, license, vendor, and documentation URL. Build output must include image digest, SBOM path, provenance path, and smoke command.
EXIT: Docker/worker images are minimal, reproducible, non-root, secret-free, and traceable to source.

REDLINE: worker/runtime families are source-rich but operationally uneven. Python trainer/runtime apps, distill/quantize/tokenize workers, compile server, MCP service, and edge/runtime optimization workers need one worker contract before they are production surfaces.
ACTION: CREATE `docs/internal/worker-runtime-contract.json`, `src/ops/worker-contract.js`, `scripts/build-worker-runtime-contract.cjs`, and `tests/worker-runtime-contract.test.js`; WIRE `apps/trainer`, `apps/runtime`, `apps/export`, `apps/import`, `apps/eval`, `workers/*`, `services/*`, Dockerfiles, package manifests, account worker pages, and CLI doctor.
CODE: each worker declares language, package manager, entrypoint, input schema, output schema, artifact outputs, local dry-run command, production run command, queue/topic, job kind, required env, optional env, CPU/GPU/memory limits, timeout, cancellation behavior, retry behavior, cache directories, network egress, object-storage dependencies, telemetry spans, logs, health/readiness, package state, and claim scope.
EXIT: a worker cannot be advertised until its dry-run, package/install state, job schema, resource policy, telemetry, and output artifact contract exist.

REDLINE: OpenTelemetry export exists as a lightweight custom OTLP/HTTP sender, but production observability cannot rely on free-form attributes and experimental GenAI convention drift.
ACTION: CREATE `src/ops/otel-semconv-policy.js`, `docs/internal/otel-semconv-policy.json`, and `tests/otel-semconv-policy.test.js`; WIRE `src/otel.js`, provider calls, capture, distill, compile, runtime, MCP, workers, metrics, and account telemetry.
CODE: the policy must pin semantic convention version, require `OTEL_SEMCONV_STABILITY_OPT_IN` behavior for GenAI attributes, define Kolm extension attributes, forbid prompt/input/output payloads by default, bound provider/model label cardinality, hash tenant/artifact ids, and map operations to spans/events/metrics with explicit sampling.
CODE: required operation spans include `kolm.gateway.capture`, `kolm.provider.call`, `kolm.artifact.compile`, `kolm.distill.job`, `kolm.eval.run`, `kolm.runtime.invoke`, `kolm.storage.object`, `kolm.billing.webhook`, `kolm.account.action`, `kolm.mcp.tool`, and `kolm.worker.job`.
EXIT: telemetry is useful to operators and safe for customers; it never exports secrets, prompts, PHI, raw tenant ids, or unbounded labels.

REDLINE: readiness is not one boolean. A route can be alive while object storage, provider credentials, workers, billing webhooks, model runtime, or telemetry are not production-ready.
ACTION: CREATE `src/ops/readiness-tree.js`, `docs/internal/readiness-tree.json`, and `public/account/readiness-tree.html`; WIRE `/health`, `/ready`, `/ready/deep`, `/v1/cloud/readiness`, `/v1/storage/object-readiness`, `/v1/product/graph`, worker readiness, account overview, CLI doctor, and deployment smoke.
CODE: readiness tree nodes must include `component_id`, `surface`, `status`, `configured`, `required`, `dependency_type`, `last_checked_at`, `latency_ms`, `safe_detail`, `operator_action`, `user_action`, `blocks_traffic`, `blocks_claim`, `blocks_release`, and `secret_values_included: false`.
CODE: statuses must be `unknown`, `not_configured`, `configured_unverified`, `ready`, `degraded`, `down`, `external_gated`, `local_only`, `package_missing`, and `claim_gated`.
EXIT: account, API, CLI, and deploy smoke all show the same readiness tree and cannot market blocked components as ready.

REDLINE: release provenance is not complete until generated docs, OpenAPI, product graph, public assets, SDK packages, Docker images, and worker packages are all linked to source, build inputs, and builder identity.
ACTION: CREATE `reports/releases/<release-id>/slsa-provenance-index.json`, `src/release/provenance-index.js`, and `scripts/build-provenance-index.cjs`; WIRE Docker build attestations, package publish outputs, generated docs, route contracts, screenshot evidence, and product graph.
CODE: each subject must include path or artifact URI, digest, media type, builder id, build type, source commit, input manifests, dependency lockfiles, environment, command, generated-by script, SLSA level target, signature status, verification command, and distribution channel.
EXIT: public and customer-delivered artifacts can be traced back to exact source and build process without trusting a terminal transcript.

REDLINE: incident and rollback behavior must be implemented before the first serious customer production deployment, not after it breaks.
ACTION: CREATE `docs/internal/rollback-contract.json`, `src/ops/rollback-plan.js`, `scripts/build-rollback-plan.cjs`, `public/account/rollback.html`, and `docs/runbooks/production-rollback.md`; WIRE deployment topology, release evidence, feature flags, provider routing, artifact supersession, job queues, object storage, and account operations.
CODE: rollback plans must declare release rollback, route disablement, provider disablement, artifact rollback/supersession, job queue pause, billing webhook replay, storage failover, account maintenance mode, DNS/static rollback, and customer communication. Each action declares owner, preconditions, command/API, data-loss risk, expected duration, verification, and undo.
EXIT: when a deploy, provider, storage, billing, distill, runtime, or artifact path fails, the team has an executable rollback path and account-visible status.

REDLINE: Docker images are not finished unless they run least-privilege and are reproducible enough to debug.
ACTION: REPLACE Dockerfiles with multi-stage builds where applicable, non-root runtime users, explicit health/readiness strategy, pinned base image policy, lockfile install, no baked secrets, and SBOM/provenance output.
CODE: root `Dockerfile`, `apps/trainer/Dockerfile`, and `workers/compile-server/Dockerfile` must declare builder stage, runtime stage, `USER`, `WORKDIR`, copied artifacts, dependency install source, healthcheck or orchestrator probe policy, and build metadata labels.
EXIT: container release evidence can prove image digest, source commit, package lock, SBOM, non-root execution, and health behavior.

REDLINE: Vercel/Railway/static deploy inclusion rules can leak internal docs, data, reports, or scratch artifacts.
ACTION: CREATE `docs/internal/deploy-include-exclude-report.json` from the deploy topology builder.
CODE: `.vercelignore`, `vercel.json`, Railway config, Docker context, npm package `files`, and public static roots must be checked against the source-boundary manifest. Internal research docs, local data, `.env*`, reports, screenshots, archives, caches, Python bytecode, SDK build outputs, and temp backups must be excluded unless a release artifact explicitly owns them.
EXIT: deployment cannot accidentally ship local state or internal redline/spec material.

REDLINE: release artifact versioning is split across many manifests.
ACTION: CREATE `src/release/version-authority.js` and `docs/internal/version-authority.json`.
CODE: root version, CLI version, package versions, SDK versions, OpenAPI version, docs build hash, product graph version, worker package versions, Docker tags, release notes, and changelog entries must derive from one release id and commit.
EXIT: a deployed site, CLI, API docs, package, worker image, and account page can all report the same release identity.

#### Production Operations, Telemetry, And Data State Implementation Blueprint

REDLINE: operational telemetry exists in fragments (`src/event-store.js`, `src/log.js`, `src/prometheus-exporter.js`, `src/k8s-routes.js`, `src/agent-telemetry.js`), but there is no single telemetry contract that every product surface must emit.
ACTION: CREATE `src/ops/telemetry-contract.js`, `src/ops/otel-mapper.js`, `docs/internal/telemetry-event-contract.json`, and `docs/internal/telemetry-field-policy.json`; WIRE route contracts, capture, distill, compile, runtime, account actions, billing, storage, workers, CLI, and TUI to it.
CODE: every telemetry event must declare `event_name`, `product_surface`, `journey`, `route_id`, `tenant_hash`, `actor_type`, `artifact_id_hash`, `job_id`, `provider`, `model`, `runtime`, `operation`, `status`, `error_code`, `latency_ms`, `tokens`, `cost_micro_usd`, `queue_ms`, `retry_count`, `cache_hit`, `readiness_status`, `sampling_class`, `privacy_class`, `redaction_policy`, and `trace_id`. Map GenAI model/provider calls to OpenTelemetry GenAI semantic conventions while freezing the emitted convention version because current GenAI conventions are still development-state and require explicit opt-in strategy.
EXIT: capture, routing, distill, compile, runtime, account, billing, and admin surfaces can be traced end-to-end without prompt/secret leakage or one-off event shapes.

REDLINE: Prometheus metrics are registered locally, but metric ownership, units, labels, cardinality, and SLO use are not enforced across the whole app.
ACTION: CREATE `src/ops/metrics-registry.js`, `docs/internal/metrics-contract.json`, and `scripts/build-metrics-contract.cjs`; REPLACE ad hoc metric names and labels with the registry.
CODE: every metric row declares name, type, unit suffix, help text, allowed labels, cardinality budget, owner, source event, SLO use, dashboard panel, alert rule, account surface, and deprecation state. Kolm-specific metrics use the `kolm_` prefix, seconds/bytes/total suffixes where appropriate, finite bounded label values, and no raw tenant/user/artifact/provider key values.
EXIT: `/metrics`, `/metrics/extended`, Grafana dashboards, Datadog/Honeycomb configs, account telemetry, and alert rules consume the same metric registry.

REDLINE: SLOs are not a runtime primitive, so "ready", "healthy", "fast", "production-ready", and "degraded" can mean different things per route.
ACTION: CREATE `src/ops/slo-contract.js`, `docs/internal/slo-contract.json`, `public/account/slo-status.html`, and `scripts/build-slo-report.cjs`; WIRE public health, deep readiness, route contracts, metrics, account overview, deploy topology, and incident response to it.
CODE: define SLIs and SLOs for API availability, p95/p99 latency, capture durability, distill job enqueue latency, artifact compile success, storage round-trip success, provider fallback rate, account data-load success, checkout/webhook success, and docs/API availability. Each SLO declares rolling window, target, burn-rate thresholds, error budget, alert destination, freeze policy, rollback trigger, owner, and user-facing status copy.
EXIT: release and deploy decisions can be blocked by error-budget burn or missing SLO instrumentation, not by subjective confidence.

REDLINE: `/health`, `/ready`, and `/ready/deep` exist, but readiness is not modeled as a multi-stage deploy gate for every runtime and worker.
ACTION: CREATE `src/ops/readiness-contract.js`, `docs/internal/readiness-contract.json`, and WIRE `src/env.js`, `src/k8s-readiness.js`, `src/k8s-routes.js`, worker Docker/Helm configs, Vercel/Railway deploys, and account cloud/storage pages to it.
CODE: readiness states must include `alive`, `startup_pending`, `config_missing`, `dependency_missing`, `artifact_cold`, `degraded`, `ready`, `draining`, and `maintenance`. Each target declares startup probe, liveness probe, readiness probe, dependency checks, artifact warm checks, provider/storage checks, failure codes, and traffic behavior. Kubernetes startup probes must shield long artifact/model initialization from premature liveness/readiness failure.
EXIT: platform probes, account readiness, CLI readiness, deploy smoke, and public status all describe the same operational state.

REDLINE: job state is split across `src/jobs.js`, `src/compile.js`, active-learning queues, load queues, approvals, distill workers, Python trainers, and JSON/SQLite stores.
ACTION: CREATE `src/ops/job-contract.js`, `src/ops/job-state-machine.js`, `src/ops/job-store.js`, `docs/internal/job-state-contract.json`, and `public/account/jobs.html`; WIRE compile, distill, eval, replay, capture export, quantize, export, runtime build, tokenization, approval, and active-learning jobs to it.
CODE: every job must have `job_id`, `tenant_id`, `surface`, `kind`, `state`, `attempt`, `idempotency_key`, `created_by`, `input_hash`, `output_hash`, `lease_owner`, `lease_expires_at`, `queued_at`, `started_at`, `heartbeat_at`, `completed_at`, `cancelled_at`, `failed_at`, `retry_policy`, `cancel_policy`, `resource_limits`, `artifact_outputs`, `logs_ref`, `telemetry_trace_id`, and `user_safe_error`. Legal states are `created`, `queued`, `leased`, `running`, `waiting_for_approval`, `waiting_for_dependency`, `retry_wait`, `succeeded`, `failed`, `cancelled`, `expired`, and `quarantined`.
EXIT: every long-running product action has cancellation, retry, resume, logs, account visibility, CLI visibility, and typed failure behavior.

REDLINE: local JSON, SQLite, JSONL, cache, backup, WAL/SHM, generated reports, and object storage are used as product state without one data-lifecycle authority.
ACTION: CREATE `src/ops/data-catalog.js`, `src/ops/migration-runner.js`, `docs/internal/data-catalog.json`, `docs/internal/schema-migrations.json`, and `scripts/build-data-catalog.cjs`; WIRE `src/store.js`, `src/event-store.js`, object storage, job store, audit retention, exports, deploy include/exclude rules, and account privacy pages to it.
CODE: every table/file/object prefix declares owner, schema version, primary keys, tenant key, retention, backup, encryption, PII/PHI/secrets class, migration path, rollback compatibility, exportability, deletion behavior, release inclusion, and local/prod mode. Migrations are numbered, idempotent, reversible when safe, tenant-fenced, and record completion rows. Raw local state under `data/`, `.kolm-*`, `tmp/`, reports, and caches must be classified as fixture/dev/prod/scratch before release tooling can include it.
EXIT: data cannot silently migrate, deploy, leak, or remain forever without a lifecycle policy.

REDLINE: security and operational logs are best-effort, but incident responders need one safe evidence stream that cannot leak prompts, keys, PHI, or proprietary artifacts.
ACTION: CREATE `src/ops/security-event.js`, `src/ops/log-policy.js`, `docs/internal/security-event-contract.json`, and `docs/internal/log-redaction-policy.json`; WIRE auth, API keys, billing, provider credentials, storage, admin actions, route errors, worker failures, and account setting changes.
CODE: log events must include normalized `when`, `where`, `who`, `what`, `target`, `result`, `reason`, `correlation_id`, `trace_id`, `request_id`, and `risk_level`, with UTC timestamps and explicit redaction before emit. Security events must cover auth failures, privilege changes, key create/rotate/revoke, SSO/SCIM changes, billing plan changes, export/download, object delete, provider credential change, policy override, deploy/rollback, and suspicious capture/model traffic.
EXIT: incident response has enough information to act, and logs remain safe to forward to SIEM/observability systems.

REDLINE: admin and operator controls are scattered between account pages, env vars, CLI commands, and private route behavior.
ACTION: CREATE `public/account/operations.html`, `public/account/incidents.html`, `src/ops/admin-actions.js`, and `docs/internal/operator-action-contract.json`; WIRE account shell, CLI/TUI, route contracts, SLOs, job state, storage readiness, deploy topology, and audit events.
CODE: each operator action declares label, permission, confirmation, blast radius, rollback path, dry-run support, disabled reason, expected duration, telemetry event, audit event, and support/runbook link. Include controls for queue pause/resume, load-shed mode, provider disablement, credential readiness refresh, artifact rollback, job cancel/retry, maintenance mode, storage smoke, release compare, and incident export.
EXIT: post-auth account UX becomes an operational console with safe actions, not just read-only diagnostics or disconnected settings.

REDLINE: incident response is not executable by code.
ACTION: CREATE `src/ops/incident-pack.js`, `scripts/build-incident-pack.cjs`, `docs/runbooks/*.md`, and `reports/incidents/<incident-id>/incident-pack.json`.
CODE: incident packs must gather release id, route errors, SLO burn, metrics, sanitized logs, traces, event-store samples, affected tenants, provider/storage/deploy status, recent changes, current feature flags, rollback candidates, runbook steps, owner, timeline, decision log, and customer-facing status copy.
EXIT: an outage, provider failure, cost spike, distill regression, storage degradation, auth failure, or artifact rollback can be handled from one generated evidence pack.

REDLINE: background work and schedules are not governed as first-class production dependencies.
ACTION: CREATE `src/ops/scheduler-contract.js`, `docs/internal/scheduled-work-contract.json`, and `scripts/build-scheduled-work-contract.cjs`; WIRE retention enforcement, cache cleanup, benchmark refresh, package/readiness closeout generation, sitemap/docs generation, artifact expiry, billing reconciliation, webhook retry, and status email.
CODE: every scheduled unit declares cadence, jitter, lock key, max runtime, retry policy, idempotency, missed-run behavior, manual trigger, owner, input/output paths, telemetry, and account/admin visibility. Scheduled jobs must use leases so Vercel/Railway/Kubernetes multi-instance deploys cannot run destructive work twice.
EXIT: recurring work becomes observable and safe under retries, restarts, and multiple instances.

REDLINE: production user experience cannot be optimized without measuring product-task success, load states, and UI regressions as first-class events.
ACTION: CREATE `src/ops/product-ux-telemetry.js`, `public/account/ux-metrics.html`, and `docs/internal/product-ux-telemetry-contract.json`; WIRE public pages, docs, demo runner, ROI calculator, account product matrix, account actions, and route errors.
CODE: emit route/page view, first meaningful action, form abandon, API doc copy event, demo run outcome, account page data-load outcome, CTA outcome, pricing inquiry outcome, upgrade funnel step, docs search outcome, screenshot build hash, Core Web Vitals, and UI error boundary events. Follow the design-system rule that operational dashboards use dense status surfaces, stable dimensions, visible focus, clear disabled reasons, and no hover-only controls.
EXIT: website and account product improvements can be tied to conversion, activation, task success, load performance, and support burden.

### AI Product Capability Redlines

REDLINE: route/capture is not complete until model traffic becomes a durable owned artifact path.
ACTION: IMPLEMENT capture-to-artifact flow across gateway route, event store, privacy membrane, opportunity detection, artifact build, account state, CLI handoff, docs tutorial, and production evidence.
CODE: a captured call must record provider/model/cost/tokens/latency/redaction/provenance, expose replay/eval readiness, create or update an artifact opportunity, and show next action in account and CLI.
EXIT: "replace one AI API" is a working product loop, not only a route.

REDLINE: distill/compile is not complete until a user can produce a scoped, signed, evaluated `.kolm` artifact from real data.
ACTION: IMPLEMENT task data intake, teacher/student metadata, method selection, split policy, K-Score calibration state, placeholder-data block, signed artifact output, failure diagnostics, and account/CLI/docs handoff.
CODE: build output must distinguish `artifact_built`, `sample_only`, `production_ready`, `eval_scope`, `calibration_status`, `safe_to_promote`, and `next_required_action`.
EXIT: users know exactly whether an artifact is real, sample-only, blocked, or production-ready.

REDLINE: run/govern/device is not complete until artifact placement is explainable and stateful.
ACTION: IMPLEMENT runtime placement across local CPU/GPU, browser, device, workers, cloud storage, BYOC, and governed deployment.
CODE: placement must account for runtime compatibility, memory, quantization, cost, latency, storage provider, region, residency, credentials, tenant policy, audit/export needs, and rollback.
EXIT: "run anywhere" becomes a placement decision with proof, not a slogan.

#### Distillation And Compilation Implementation Blueprint

REDLINE: `apps/trainer/`, `workers/distill/`, `src/distill-pipeline.js`, and `src/compile-pipeline.js` are not finished until they share one job contract.
ACTION: CREATE `src/ai/distill-contract.js`, `src/ai/compile-contract.js`, `docs/internal/distillation-method-matrix.json`, and `docs/internal/compile-artifact-contract.json`; WIRE Node routes, CLI commands, Python trainer, distill worker, account distill pages, artifact builder, and docs to the same contract.
CODE: the shared distill job contract must include:

```json
{
  "job_id": "dst_...",
  "tenant_id": "t_...",
  "namespace": "support",
  "task_type": "classification|extraction|generation|tool_use|rag|multimodal",
  "teacher": {"provider": "openai|anthropic|gemini|local|ensemble", "model": "...", "version": "..."},
  "student": {"family": "gemma|llama|qwen|phi|custom", "size": "...", "architecture_source": "manual|taas|template"},
  "dataset": {"source": "capture|upload|synthetic|fixture", "rows": 0, "train_rows": 0, "holdout_rows": 0, "rights": "customer|public|synthetic", "redaction": "passed|blocked|not_applicable"},
  "method": {"name": "importance_weighted|teacher_council|reasoning_trace|contrastive|progressive|rag_aware|tool_use", "version": "..."},
  "calibration": {"kscore_pack": "...", "human_preference_mapping": "present|missing", "benchmark_scope": "private|public|fixture"},
  "promotion_gate": {"production_ready": false, "sample_only": false, "placeholder_eval": false, "safe_to_promote": false},
  "outputs": {"artifact_path": null, "manifest_hash": null, "receipt_id": null, "model_card": null, "export_targets": []}
}
```

CODE: `apps/trainer` must accept this contract as input and return the same shape with updated state. `workers/distill` must use the same contract; `stub` mode must be renamed `fixture_only` and rejected outside local/test contexts. `src/compile-pipeline.js` must refuse production promotion if dataset rights, redaction, holdout, calibration, artifact signature, or eval scope are missing.

EXIT: distill/compile cannot produce an artifact that looks production-ready unless the contract proves real data, rights, eval scope, calibration state, signature, and runtime target evidence.

REDLINE: student architecture selection is not a product capability until it produces reproducible candidates, budgets, and tradeoffs.
ACTION: CREATE `src/ai/student-architecture-search.js`, `apps/trainer/taas.py`, and `docs/internal/student-architecture-matrix.json`.
CODE: TAAS must generate candidate students from task type, context length, latency budget, memory budget, target devices, teacher difficulty, dataset size, and K-Score target. Each candidate records parameter count, layer count, hidden size, attention pattern, tokenizer, context length, expected memory, training cost, export targets, and failure risk. It must emit a deterministic search trace and choose a default with explicit tradeoffs.
EXIT: "task-adaptive student architecture selection" becomes an executable planner, not roadmap copy.

REDLINE: confidence-aware routing is not complete until it controls fallback, cost, and quality in production.
ACTION: CREATE `src/ai/confidence-routing-policy.js`, `src/ai/router-calibration.js`, and account/CLI surfaces for route policy state.
CODE: policies must combine student confidence, K-Score calibration, uncertainty, prompt class, user risk tier, latency SLO, cost budget, local/cloud availability, and enterprise policy. Routing decisions must record `student_used`, `teacher_fallback`, `blocked_by_policy`, `confidence`, `threshold`, `cost_delta`, `latency_delta`, and `quality_risk`.
EXIT: hybrid local-cloud inference is a governed runtime feature with traceable decisions.

#### Quantization And Runtime Optimization Blueprint

REDLINE: `workers/quantize/`, `src/quantization-oracle.js`, and export backends are not finished until quantization choices are tied to calibration, target runtime, and accuracy deltas.
ACTION: CREATE `src/ai/quantization-contract.js`, `docs/internal/quantization-method-matrix.json`, and `docs/internal/runtime-optimization-matrix.json`; WIRE `workers/quantize`, `apps/export/*`, runtime placement, account runtime pages, and CLI quantize commands to them.
CODE: every quantization job must declare method (`dynamic_int8`, `static_int8`, `awq`, `smoothquant`, `gptq`, `gguf_q4_k_m`, `mlx_4bit`, `onnx_int8`, `tensorrt_fp8`), target (`onnxruntime`, `vllm`, `llama.cpp`, `mlx`, `executorch`, `tensorrt`, `browser`, `qnn`, `openvino`), calibration data, activation outlier handling, weight/activation bit width, expected memory, measured memory, throughput, latency, accuracy delta, K-Score delta, unsupported layers, and rollback artifact.
EXIT: quantization recommendations become reproducible deployment decisions with measured tradeoffs.

REDLINE: runtime placement cannot be trusted while workers/exporters report only plan/applicable without a unified compatibility contract.
ACTION: CREATE `src/ai/runtime-compatibility.js`, `apps/export/export_contract.py`, and `docs/internal/export-target-matrix.json`.
CODE: every exporter in `apps/export/` must implement:

```python
def plan(artifact_dir) -> ExportPlan: ...
def doctor() -> ExportDoctor: ...
def export(artifact_dir, out_dir, options) -> ExportResult: ...
def smoke(export_dir) -> ExportSmoke: ...
```

`ExportResult` must include target, versions, commands run, source artifact hash, output hashes, model license, toolchain paths, optional dependency state, quantization state, runtime compatibility, and failure reason. Applicable-but-missing-toolchain must be a typed blocked state, not a generic exception.

EXIT: Core ML, ExecuTorch, GGUF, MLX, ONNX, TensorRT, model-card, SBOM, and AI Act exports all expose the same lifecycle and can be rendered in account/CLI/docs.

REDLINE: serving optimizations are not finished until Kolm records when to use them and when to skip them.
ACTION: CREATE `src/ai/serving-optimizer.js`, `docs/internal/serving-optimization-matrix.json`, and worker contracts for `workers/tsac/`, `workers/itkv/`, `workers/runtime-build/`, and `workers/constrained/`.
CODE: optimizations must model continuous batching, KV-cache policy, prefix caching, speculative decoding, student-as-draft, sparse attention, tiered KV cache, CPU/GPU offload, batch-vs-latency kernels, and graceful degradation. Each row declares prerequisites, incompatible modes, model families, context limits, memory impact, expected speedup, quality risk, fallback, and evidence.
EXIT: Kolm runtime features improve latency/cost only when the artifact and environment support them.

#### Python And Worker Productionization Blueprint

REDLINE: Python apps and workers are product runtime surfaces, not script folders.
ACTION: CREATE `scripts/build-python-worker-runtime-matrices.cjs`, `docs/internal/python-app-runtime-matrix.json`, `docs/internal/worker-runtime-matrix.json`, and `docs/internal/service-runtime-matrix.json`.
CODE: every app/worker must declare owner, product surface, supported status, entrypoint, package manager, lock/constraints file, environment variables, GPU/toolchain needs, doctor command, smoke command, input schema, output schema, artifact paths, telemetry fields, timeout, memory limit, concurrency limit, secret policy, local-only/production mode, container image, healthcheck, and account/CLI/docs exposure.
EXIT: a Python app or worker cannot be marketed or called from product code unless it has a runtime contract.

REDLINE: worker `stub` and fallback paths can silently become product behavior.
ACTION: REPLACE `stub` labels with `fixture_only` or `mock_only` and enforce mode guards in worker entrypoints, account UI, CLI output, and route contracts.
CODE: fixture-only outputs must include `production_ready=false`, `fixture_only=true`, `promotion_blocked=true`, `blocked_reason`, and `next_required_action`; production routes must reject fixture-only worker results unless explicitly running a local/test command.
EXIT: demo/test outputs cannot be mistaken for trained, quantized, exported, or production-ready artifacts.

REDLINE: external model/tool dependencies are not safe until the artifact records versions, licenses, and provenance.
ACTION: CREATE `src/ai/dependency-provenance.js` and WIRE it into trainer, importers, exporters, quantizers, runtime placement, and artifact manifest generation.
CODE: record model id, revision, license, source URL, checksum/hash, tokenizer version, dataset rights, tool version, container digest, Python package lock hash, Node lock hash, CUDA/ROCm/Metal/OpenVINO/QNN versions, and any manual override. Block export/publish when license or provenance is missing for a target that requires it.
EXIT: `.kolm` artifacts carry dependency provenance strong enough for enterprise review and downstream runtime debugging.

#### Evaluation, K-Score, And Benchmark Implementation Blueprint

REDLINE: K-Score and evals are not finished until private quality, public benchmark, and human calibration are separate code paths.
ACTION: CREATE `src/ai/evaluation-contract.js`, `docs/internal/evaluation-method-matrix.json`, and `docs/internal/kscore-calibration-matrix.json`; WIRE `apps/eval/*`, `src/kscore.js`, `src/quality-calibration.js`, `src/benchmark-evidence.js`, account quality pages, and CLI eval commands.
CODE: every evaluation output must declare `eval_scope` (`fixture`, `private_customer`, `public_benchmark`, `human_calibrated`), dataset id, dataset rights, judge model, judge version, calibration pack, confidence interval, task class, false accept risk, false reject risk, and whether the score is promotable.
EXIT: sample K-Score, customer K-Score, public benchmark score, and human-calibrated score cannot be conflated in code, docs, account UI, or marketing.

REDLINE: benchmark claims cannot ship from ad hoc examples.
ACTION: CREATE `reports/benchmarks/<run-id>/benchmark-evidence.json` and generate public benchmark pages only from dated evidence.
CODE: benchmark evidence must include model/provider versions, hardware, runtime backend, quantization, dataset, prompt format, scoring, latency, throughput, cost, energy if available, raw outputs, failure cases, and reproducibility command.
EXIT: public benchmark pages cite reproducible evidence instead of broad "faster/better/cheaper" claims.

#### Artifact Registry, Marketplace, Provenance, And Ecosystem Loader Blueprint

SOURCE ANCHORS: OCI Distribution Spec 1.1 content discovery/referrers, OCI Image/Artifact descriptor model, ORAS artifact workflows, Sigstore/Cosign keyless signing and bundle verification, SLSA provenance v1.1, SPDX 3.0.1, and CycloneDX 1.6 must be treated as implementation inputs for `.kolm` publishing.

REDLINE: Kolm has artifacts, registry pages, marketplace pages, Sigstore blocks, SBOM emitters, lineage, and loaders, but not one content-addressed artifact data plane.
ACTION: CREATE `src/artifacts/artifact-address.js`, `src/artifacts/artifact-store.js`, `src/artifacts/artifact-index.js`, `src/artifacts/artifact-state-machine.js`, `docs/internal/artifact-data-plane-contract.json`, and `public/account/artifacts.html`; WIRE `src/artifact.js`, `src/artifact-runner.js`, `src/artifact-lineage.js`, `src/registry.js`, `src/marketplace.js`, object storage, account artifacts, CLI artifacts, and public registry pages.
CODE: every artifact must have stable identity:

```json
{
  "artifact_id": "art_...",
  "name": "claims-redactor",
  "version": "1.2.0",
  "digest": "sha256:...",
  "content_address": "kolm://sha256/...",
  "media_type": "application/vnd.kolm.artifact.v1+zip",
  "artifact_class": "workflow|distilled_model|guardrail|eval_pack|adapter|agent|pipeline",
  "tenant_id": "...",
  "visibility": "private|team|public|marketplace",
  "state": "draft|built|signed|attested|published|deprecated|revoked|quarantined",
  "current_version_id": "..."
}
```

CODE: content address, manifest digest, receipt digest, signature digest, provenance digest, SBOM digest, model-card digest, and public registry digest must be separate fields. Mutable tags point at immutable digests. Account UI must show digest, version, state, trust, size, runtime compatibility, and next action.
EXIT: `.kolm` artifacts become immutable, addressable, governable product objects rather than files that happen to sit under `examples/` or `public/registry-pack/`.

REDLINE: publishing cannot be finished while marketplace catalog entries are hand-curated seed rows with local path assumptions.
ACTION: CREATE `src/artifacts/publish-workflow.js`, `src/artifacts/marketplace-review.js`, `src/artifacts/publisher-profile.js`, `docs/internal/marketplace-publish-contract.json`, and `public/account/marketplace-publisher.html`; WIRE `src/marketplace.js`, `src/marketplace-routes.js`, `src/marketplace-store.js`, `src/marketplace-payouts.js`, `src/publisher-verification.js`, registry pack builder, public pages, and CLI publish.
CODE: publish states must include `draft`, `local_verified`, `metadata_complete`, `security_scan_passed`, `eval_attached`, `license_review`, `publisher_verified`, `review_pending`, `approved`, `published`, `rejected`, `suspended`, `deprecated`, and `revoked`.
CODE: marketplace cards are generated only from publish workflow state and immutable artifact evidence. Each card declares publisher, license, verified status, eval scope, benchmark date, trust status, model/data rights, runtime compatibility, price/free state, support contact, install command, and reason any badge is shown.
EXIT: marketplace trust is earned by artifact evidence and review state, not by a static badge in a JavaScript seed list.

REDLINE: the registry should use proven distribution patterns instead of inventing a fragile `.kolm` download silo.
ACTION: CREATE `src/artifacts/oci-layout.js`, `src/artifacts/oci-push-pull.js`, `docs/internal/oci-artifact-mapping.json`, and `scripts/build-oci-registry-pack.cjs`; WIRE registry pack, object storage, CLI publish/pull, marketplace download, and ecosystem loaders.
CODE: map `.kolm` to OCI-style descriptors:

```json
{
  "manifest_media_type": "application/vnd.oci.image.manifest.v1+json",
  "artifact_type": "application/vnd.kolm.artifact.v1",
  "config_media_type": "application/vnd.kolm.config.v1+json",
  "layers": [
    {"mediaType": "application/vnd.kolm.manifest.v1+json"},
    {"mediaType": "application/vnd.kolm.recipe.v1+json"},
    {"mediaType": "application/vnd.kolm.weights.v1"},
    {"mediaType": "application/vnd.kolm.evals.v1+json"}
  ],
  "referrers": ["sbom", "slsa_provenance", "signature", "model_card", "policy"]
}
```

CODE: implement local OCI layout export/import first, then remote registry push/pull with digest verification, resumable upload/download, referrer discovery for signatures/SBOM/provenance, and fallback behavior for registries without referrers support.
EXIT: Kolm can distribute artifacts through standard registry infrastructure while keeping `.kolm` semantics.

REDLINE: artifact signatures and attestations are not complete while Sigstore dry-run, Ed25519, SBOM, and SLSA evidence are separate optional blocks.
ACTION: CREATE `src/artifacts/trust-bundle.js`, `src/artifacts/attestation-policy.js`, `src/artifacts/verification-result.js`, `docs/internal/artifact-trust-bundle-contract.json`, and `public/account/artifact-trust.html`; WIRE `src/sigstore.js`, `src/sbom-emit.js`, `src/provenance.js`, `src/export-provenance.js`, `packages/attestation`, CLI verify, account artifacts, and marketplace review.
CODE: every trust bundle must carry:

```json
{
  "signature": {"kind": "ed25519|sigstore_keyless|kms", "verified": true},
  "transparency": {"kind": "rekor|private_log|none", "verified": false},
  "provenance": {"predicate_type": "https://slsa.dev/provenance/v1", "verified": true},
  "sbom": {"format": "spdx-3.0.1|cyclonedx-1.6", "verified": true},
  "model_card": {"verified": true},
  "policy": {"runtime_allowed": true, "marketplace_allowed": true}
}
```

CODE: verification results must distinguish `valid`, `valid_offline`, `dry_run_only`, `signature_missing`, `transparency_unconfirmed`, `provenance_missing`, `sbom_missing`, `policy_blocked`, `revoked`, `expired`, and `unknown_trust_root`. UI badges must map exactly to these states.
EXIT: artifact trust has one machine-readable result that governs runtime load, publish, marketplace display, account trust, and CLI verification.

REDLINE: lineage and diff are useful but not yet a graph product.
ACTION: CREATE `src/artifacts/lineage-graph.js`, `src/artifacts/version-diff-engine.js`, `docs/internal/artifact-lineage-graph-contract.json`, and `public/account/artifact-lineage.html`; WIRE `src/artifact-lineage.js`, `src/artifact-diff.js`, `src/kolm-diff.js`, `src/distill-provenance.js`, compile/distill pipelines, A/B tests, and marketplace versions.
CODE: every version edge declares parent digest, source captures, teacher model, student base, dataset hash, eval pack, quantization plan, runtime target, policy changes, publisher action, and approval id. Diff output must classify changes as `behavior`, `data`, `weights`, `policy`, `runtime`, `metadata`, `trust`, or `docs`.
EXIT: users can answer "what changed, why, from what data, who approved it, and can I roll back" for every artifact.

REDLINE: artifact composition/pipelines cannot just concatenate manifests.
ACTION: CREATE `src/artifacts/pipeline-composer.js`, `src/artifacts/composition-validator.js`, `docs/internal/artifact-composition-contract.json`, and `public/account/pipelines.html`; WIRE `src/composer.js`, agent composition, guardrails, artifacts, runtime policy, account pipeline pages, and CLI compose.
CODE: composition nodes declare input schema, output schema, policy, runtime, latency/cost budget, data classes, failure behavior, rollback behavior, and eval gate. Edges declare type compatibility, redaction boundary, trust transfer, audit event, and retry policy.
CODE: pipeline publish requires every component artifact to be trusted, compatible, licensed, non-revoked, and covered by an eval pack for the composed behavior.
EXIT: "artifact composition" becomes a verifiable pipeline product, not a brittle workflow demo.

REDLINE: ecosystem import/export is not done until outside formats have loss accounting and trust states.
ACTION: CREATE `src/artifacts/import-export-contract.js`, `src/artifacts/format-adapters/`, `docs/internal/ecosystem-loader-matrix.json`, and `public/account/import-export.html`; WIRE `src/import.js`, `src/export-provenance.js`, runtime adoption packets, tests for loaders, docs import pages, and marketplace import.
CODE: every adapter row declares source/target format, supported fields, dropped fields, trust model, license/provenance extraction, tokenizer handling, weights handling, eval import, model card import, SBOM/provenance import, runtime compatibility, and round-trip status. Include GGUF, safetensors, ONNX, Core ML, ExecuTorch, MLX, TensorRT, Hugging Face repo, Ollama Modelfile, LM Studio, vLLM, llama.cpp, and OpenAI-compatible prompt/eval traces.
EXIT: users see exactly what survives import/export and what must be revalidated before use.

REDLINE: capture, trace import, connectors, and distill datasets are the product's raw material, but they still need one data-plane lifecycle.
ACTION: CREATE `src/capture/capture-data-plane.js`, `src/capture/connector-contract.js`, `src/capture/trace-importer.js`, `docs/internal/capture-data-plane-contract.json`, and `public/account/capture-data-plane.html`; WIRE `src/capture-store.js`, `src/capture.js`, `src/capture-analytics.js`, `src/tool-use-capture.js`, `src/trace-capture.js`, `src/rag-capture.js`, `src/audio-capture.js`, `src/vision-capture.js`, `src/video-capture.js`, VS Code capture queue, connectors, and account capture pages.
CODE: every captured event must travel through states:

```text
received
validated
redacted
copyright_scanned
poisoning_scored
stored
bridged_to_event_lake
clustered
scored_for_importance
eligible_for_distill
quarantined
forgotten
exported
```

CODE: connector contracts must declare auth, upstream provider, event schema, retry policy, privacy policy, rate limits, raw retention, redaction point, error mapping, tenant/team scope, local/offline support, and account setup states.
EXIT: captured traffic reliably becomes clean, governed training/eval material or is visibly quarantined/forgotten.

REDLINE: trace import from Langfuse/OpenTelemetry/custom logs cannot be trusted unless it preserves canonical identity and privacy boundaries.
ACTION: CREATE `src/capture/import-manifest.js`, `src/capture/import-checksum.js`, `src/capture/import-privacy-review.js`, and `docs/internal/trace-import-contract.json`; WIRE existing trace-import research specs, import routes, event-store, privacy membrane, account imports, and docs.
CODE: every import batch declares source system, source export id, source checksum, row count, canonicalization version, dropped rows, privacy review result, tenant/team target, namespace, time range, redaction policy, and replay eligibility.
CODE: row-level imports must preserve provider/model/tokens/cost/latency/status/tool calls/files where available and must mark unknown fields as unknown, not fake defaults.
EXIT: imported traces are usable evidence for distill/eval only when their provenance, privacy, and canonicalization are known.

REDLINE: account UX for artifacts/captures/registry must show lifecycle and proof, not just lists.
ACTION: CREATE `public/account/artifact-detail.html`, `public/account/capture-detail.html`, `public/account/marketplace-publisher.html`, and `public/account/pipeline-detail.html`; WIRE account shell, product graph, artifact data plane, capture data plane, trust bundle, lineage graph, and route contracts.
CODE: each detail page must expose state, digest, owner, trust result, lineage, eval scope, runtime compatibility, data classes, privacy status, publish status, install/run commands, last smoke, failures, next action, and destructive actions with confirmation.
EXIT: post-auth account turns the artifact platform into an operational product, not a static marketing/admin surface.

#### Code Completion, Engineering Agents, And IDE Product Blueprint

SOURCE ANCHORS: Language Server Protocol 3.17 completion semantics, VS Code inline completion provider API, SWE-bench issue-resolution benchmark, Inspect AI evaluation primitives, and OpenAI Evals must be treated as product design inputs for Kolm's code-assistant surface.

REDLINE: code completion is currently implied by VS Code distill commands, local runtime helpers, capture namespaces, and AI product claims, but it is not yet a first-class product surface.
ACTION: CREATE `src/code/code-assistant-contract.js`, `src/code/completion-context.js`, `src/code/completion-policy.js`, `docs/internal/code-assistant-product-matrix.json`, and `public/account/code-assistant.html`; WIRE VS Code extension packages, CLI capture/distill commands, account captures, artifact registry, provider routing, privacy membrane, and docs.
CODE: the code-assistant surface must define modes:

```text
inline_completion
chat_edit
repo_question_answering
test_generation
bug_fix_patch
refactor_patch
code_review
security_review
documentation_update
distill_my_workflow
local_artifact_fallback
```

CODE: every mode declares editor trigger, input context, allowed files, max tokens, local/remote policy, provider policy, privacy policy, artifact use, eval suite, failure state, and account-visible metrics.
EXIT: Kolm can say what coding workflow it improves, how it captures it, how it distills it, and how users know whether the local artifact is ready.

REDLINE: inline completion cannot be a generic chat route glued into an editor.
ACTION: CREATE `packages/vscode-kolm-rag/src/inline-completion.ts`, `packages/vscode-kolm-rag/src/lsp-bridge.ts`, `packages/vscode-kolm-rag/src/context-window.ts`, and `docs/internal/ide-completion-contract.json`; WIRE `packages/vscode-kolm-rag/src/local-runtime.ts`, `sdk/vscode/src/distill-command.js`, extension manifests, and account code-assistant settings.
CODE: implement an IDE contract aligned to LSP/VS Code semantics:

```json
{
  "request": "textDocument/completion|inlineCompletion",
  "trigger": "typing|explicit|incomplete_refresh",
  "context": {
    "document_uri": "...",
    "language_id": "typescript",
    "cursor": {"line": 10, "character": 8},
    "prefix_window": "...",
    "suffix_window": "...",
    "open_files": [],
    "repo_symbols": [],
    "recent_diagnostics": [],
    "test_context": []
  },
  "policy": {
    "allow_remote": false,
    "allow_secret_context": false,
    "max_latency_ms": 300,
    "fallback": "no_suggestion|teacher|local_artifact"
  }
}
```

CODE: inline completions must support cancellation tokens, stale request discard, debouncing, low-latency timeout, explicit trigger handling, incomplete refresh, deterministic no-suggestion state, and telemetry that records latency/acceptance without leaking source code.
EXIT: code completion is editor-native, cancellable, private-by-default, latency-bounded, and measurable.

REDLINE: repository-level code agents require patch semantics, not raw text generation.
ACTION: CREATE `src/code/patch-agent.js`, `src/code/repo-sandbox.js`, `src/code/patch-validator.js`, `src/code/test-orchestrator.js`, and `docs/internal/code-agent-contract.json`; WIRE CLI, VS Code, account, artifact registry, local runtime, and benchmark runners.
CODE: code-agent outputs must be typed:

```json
{
  "kind": "unified_diff",
  "base_commit": "...",
  "changed_files": [{"path": "src/foo.js", "action": "modify"}],
  "commands_run": ["npm test -- tests/foo.test.js"],
  "tests": [{"command": "...", "status": "pass|fail|skipped", "evidence": "..."}],
  "risk": {"files": [], "security": [], "migration": []},
  "human_review_required": true
}
```

CODE: patches must apply cleanly, avoid destructive operations, preserve unrelated dirty changes, run targeted tests when available, produce failure diagnostics, and require explicit human approval before write-back unless running in a disposable sandbox.
EXIT: the code-agent path finishes real repository work safely instead of generating code-shaped prose.

REDLINE: code-assistant distillation is not real until it learns from accepted/rejected editor and patch behavior with privacy controls.
ACTION: CREATE `src/code/code-capture-normalizer.js`, `src/code/code-distill-dataset.js`, `src/code/code-feedback-loop.js`, and `docs/internal/code-distill-dataset-contract.json`; WIRE capture namespace `vscode-codegen`, accepted completion events, rejected suggestions, patch outcomes, test results, account opt-in, and artifact build.
CODE: dataset rows must distinguish `accepted_inline_completion`, `rejected_inline_completion`, `manual_edit_after_suggestion`, `successful_patch`, `failed_patch`, `test_failure`, `review_comment`, and `security_finding`. Each row stores language, repo_hash, file_path_hash, AST/symbol context when available, prefix/suffix hashes, redaction status, license/privacy basis, and user feedback.
EXIT: "distill my coding assistant" becomes a measurable loop from real coding behavior to a scoped `.kolm` artifact.

REDLINE: coding metrics cannot stop at accept rate.
ACTION: CREATE `src/code/code-eval-suite.js`, `src/code/code-quality-metrics.js`, `reports/code-evals/<run-id>/code-eval-evidence.json`, and `public/account/code-quality.html`; WIRE K-Score, benchmark evidence, Inspect/OpenAI-style eval adapters, and SWE-bench-style issue resolution.
CODE: track latency, suggestion acceptance, edit distance after accept, compile pass rate, unit-test pass rate, lint/type pass rate, security finding rate, revert rate, time-to-green, token/cost per accepted edit, local-vs-cloud routing, and human-review override.
CODE: external claims require dated evidence by language/task/repo size and must separate private customer evals from public benchmark evals.
EXIT: Kolm can optimize code-completion quality, safety, and cost with evidence instead of generic "AI coding" claims.

REDLINE: code context is a data-exfiltration risk unless it is minimized and controlled.
ACTION: CREATE `src/code/context-policy.js`, `src/code/source-redaction.js`, `src/code/repo-permission-policy.js`, and `docs/internal/code-context-privacy-policy.json`; WIRE IDE extension, MCP tools, provider router, local runtime, capture store, account privacy settings, and security event log.
CODE: remote calls must never include `.env`, secrets, private keys, package tokens, credentials, customer data folders, ignored files, generated binaries, or files outside allowed workspace roots. Source snippets are bounded by token budget and purpose; full file/repo upload requires explicit account policy.
EXIT: code completion improves product value without silently shipping a customer's repository to a provider.

#### Runtime Execution Engine And Serving Optimization Blueprint

SOURCE ANCHORS: vLLM PagedAttention/prefix caching design, ONNX Runtime quantization docs, MLPerf Inference scenarios/metrics, and current Kolm TSAC/ITKV/constrained-decoding modules should drive the runtime completion plan.

REDLINE: runtime serving optimizations exist as separate ideas (confidence routing, TSAC, ITKV, constrained decode, preloading, placement) but not as one execution engine.
ACTION: CREATE `src/runtime/execution-engine.js`, `src/runtime/request-scheduler.js`, `src/runtime/cache-manager.js`, `src/runtime/optimization-policy.js`, and `docs/internal/runtime-execution-contract.json`; WIRE `src/runtime.js`, `src/runtime-placement.js`, `src/runtime-confidence-router.js`, `src/runtime-preload.js`, `src/tsac-compiler.js`, `src/itkv-profile.js`, `src/constrained-decode.js`, workers, account runtime pages, and CLI runtime commands.
CODE: every runtime request must produce an execution plan:

```json
{
  "artifact_id": "...",
  "runtime": "local_cpu|cuda|mps|webgpu|worker|vllm|onnx|gguf|coreml|qnn",
  "scheduler": "single|continuous_batch|priority|deadline",
  "cache_policy": "none|prefix|paged_kv|tiered_kv|itkv",
  "decode_policy": "greedy|sampling|constrained|speculative|student_draft|teacher_escalation",
  "optimization_policy": ["quantization", "tsac", "preload"],
  "fallbacks": [],
  "quality_guards": [],
  "telemetry": []
}
```

CODE: the plan must declare prerequisites, incompatible features, memory budget, token budget, max latency, quality guard, fallback path, and account-visible reason for every optimization selected or skipped.
EXIT: runtime optimization becomes explainable product behavior, not scattered heuristics.

REDLINE: KV-cache, prefix-cache, sparse attention, and speculative decoding claims require per-model evidence and failure controls.
ACTION: CREATE `src/runtime/kv-cache-policy.js`, `src/runtime/speculative-decode-policy.js`, `src/runtime/attention-policy.js`, `docs/internal/runtime-optimization-evidence.json`, and `reports/runtime/<run-id>/runtime-benchmark.json`; WIRE TSAC, ITKV, runtime placement, provider adapters, artifact manifests, and account performance pages.
CODE: each optimization row records model family, tokenizer, context length, batch shape, prompt reuse rate, cache hit rate, memory saved, throughput, p50/p95 latency, quality delta, structured-output failure delta, fallback trigger, and hardware.
CODE: optimizations that alter attention, KV precision, draft tokens, constrained decoding, or quantization must be disabled by default for safety-critical tasks until evidence exists for that task class.
EXIT: Kolm can recommend runtime optimizations with proof and can refuse unsafe speedups.

REDLINE: quantization is not complete until it is artifact-aware, target-aware, and debuggable.
ACTION: CREATE `src/runtime/quantization-plan.js`, `src/runtime/quantization-debug.js`, `docs/internal/quantization-plan-contract.json`, and `reports/quantization/<run-id>/quantization-evidence.json`; WIRE `src/quantization-oracle.js`, `src/quantize-bakeoff.js`, `workers/quantize`, model registry, artifact manifest, and account/device placement.
CODE: quantization plans must record source format, target runtime, opset/version constraints, calibration data, static/dynamic/QAT/source method, dtype, block size, excluded tensors, accuracy baseline, activation/weight matching evidence, hardware support, expected speed/memory change, and rollback artifact.
CODE: if quantization hurts accuracy beyond threshold or cannot be debugged to tensor/layer level, output is `production_ready=false` with exact failing tensors/tasks.
EXIT: "best quantization tool" means Kolm chooses, proves, debugs, and can undo quantization per artifact and target.

REDLINE: constrained decoding and structured output validation must be one path.
ACTION: CREATE `src/runtime/structured-output-engine.js`, `src/runtime/schema-decoder-policy.js`, and `docs/internal/structured-output-runtime-contract.json`; WIRE `src/constrained-decode.js`, output schema validators, API responses, account demos, guardrails, code-agent patches, and provider adapters.
CODE: every structured-output request declares schema, decoder availability, provider-native support, local decoder support, fallback behavior, validation failure handling, repair policy, retry budget, and security policy. If no constrained decoder is available, the response must say so before generation or validate-and-repair with explicit risk.
EXIT: JSON, tool calls, code patches, eval reports, and artifact manifests are structurally reliable instead of best-effort strings.

REDLINE: model/provider/runtime catalog truth is split across files and generated manifests.
ACTION: CREATE `src/runtime/model-capability-catalog.js`, `src/runtime/provider-capability-catalog.js`, `public/model-capabilities.json`, `public/runtime-capabilities.json`, and `docs/internal/model-runtime-compatibility.json`; WIRE provider registry, model registry, compute registry, catalog manifest, OpenAPI, docs, account model picker, pricing, and route/capture.
CODE: each model row declares provider, model id, version/freshness, modalities, context, logprobs support, tool/function support, JSON schema support, vision/audio/video support, cost, latency class, data retention policy, residency, terms constraints, rate limits, eval coverage, distill eligibility, quantization eligibility, runtime export targets, and fallback model.
EXIT: model-agnostic routing and run-anywhere placement use one live capability catalog.

REDLINE: runtime benchmarks must reflect MLPerf-style scenario discipline rather than one-off speed numbers.
ACTION: CREATE `src/runtime/runtime-benchmark-harness.js`, `docs/internal/runtime-benchmark-scenarios.json`, and `public/benchmarks/runtime.html`; WIRE MLPerf-style offline/server/single-stream/multi-stream scenarios, KolmBench, account runtime proof, and release evidence.
CODE: benchmark reports must include scenario, load shape, dataset, model, artifact, runtime backend, hardware, power/energy when measured, tokens/sec, latency distribution, queue time, cache state, accuracy/quality target, failure count, and reproducibility command.
EXIT: public runtime performance claims are scenario-specific, dated, reproducible, and comparable.

REDLINE: local runtime fallback in IDE and account flows is useful but not finished until installation, discovery, and failure states are explicit.
ACTION: CREATE `src/runtime/local-runtime-discovery.js`, `packages/vscode-kolm-rag/src/runtime-status.ts`, `public/account/local-runtime.html`, and `docs/internal/local-runtime-contract.json`; WIRE CLI, VS Code extension, browser demos, account devices, package release matrix, and runtime placement.
CODE: local runtime states are `not_installed`, `installed_unverified`, `version_mismatch`, `artifact_missing`, `artifact_incompatible`, `ready`, `timeout`, `crashed`, `permission_denied`, and `fallback_to_teacher`. Each state has install command, evidence, and next action.
EXIT: users understand why local/offline/device execution works or does not work.

#### Product Engine Spine, Compiler Runtime, And Completion Execution Blueprint

SOURCE ANCHORS: vLLM latest docs expose PagedAttention, automatic prefix caching, disaggregated serving, structured outputs, tool calling, quantized KV cache, and speculative decoding as concrete serving primitives. IREE documents ahead-of-time PyTorch export to deployment artifacts with externalized parameters. ONNX Runtime GenAI exposes token generation, tokenization/preprocessing, logits processing, sampling/search, structured output, and KV cache management. KServe positions `InferenceService`, `LLMInferenceService`, `ServingRuntime`, local model cache, autoscaling, serverless mode, and ModelMesh as Kubernetes serving primitives. MLIR exposes dialects, pass infrastructure, bytecode, quantization, and lowering as compiler foundations. TVM documents a compiler stack for importing models, optimizing models, cross compilation, Relax executables, TensorIR, and target-specific deployment.

REDLINE: Kolm has many engine primitives, but no single product-engine object owns the journey from captured traffic to compiled artifact to runtime decision to post-run evidence.
ACTION: CREATE `src/engine/product-engine.js`, `src/engine/product-engine-contract.js`, `src/engine/engine-state-machine.js`, `src/engine/engine-evidence.js`, `docs/internal/product-engine-contract.json`, and `public/account/product-engine.html`; WIRE `src/distill-pipeline.js`, `src/compile-pipeline.js`, `src/compile-ir.js`, `src/native-compile.js`, `src/quantization-oracle.js`, `src/runtime-confidence-router.js`, `src/tsac-compiler.js`, `src/itkv-profile.js`, `src/speculative-teacher.js`, `src/kernel-selector.js`, `src/completions-api.js`, `src/runtime-placement.js`, `src/artifact-runner.js`, CLI, account, API docs, and product graph.
CODE: every engine run must share one durable envelope:

```json
{
  "engine_run_id": "eng_...",
  "tenant_id": "t_...",
  "surface": "route_capture|compile_distill|run_anywhere|code_assistant",
  "input": {"source": "capture|trace|upload|repo|artifact", "namespace": "..."},
  "plan": {"compile_ir": null, "distill": null, "quantization": null, "runtime": null},
  "state": "planned|queued|running|blocked|failed|succeeded|promotable|deployed",
  "evidence": {"audit_event_id": "...", "artifact_digest": null, "reports": []},
  "next_action": {"kind": "fix_config|add_data|run_eval|publish|deploy|rollback", "command": "..."}
}
```

CODE: the state machine must reject hidden transitions. `distill-pipeline` async iterator events, `compile-pipeline` phase logs, quantization oracle decisions, runtime route decisions, TSAC/ITKV profiles, speculative teacher acceptance logs, and OpenAI-compatible completion provenance must all append to the same engine run id.
CODE: account pages must show engine run timeline, current blocker, evidence artifacts, commands, API route, runtime placement, cost/quality delta, and whether the result is fixture-only, private-customer-only, public-benchmark-backed, or production-ready.
EXIT: Kolm's core product is no longer a bag of scripts and route helpers; it is one inspectable engine with state, proof, and customer action.

REDLINE: distillation orchestration still mixes collection, fixture, full worker, approval, TOS policy, and production promotion in a long Node module.
ACTION: SPLIT product boundaries by creating `src/distill/distill-job.js`, `src/distill/distill-corpus.js`, `src/distill/teacher-policy.js`, `src/distill/student-planner.js`, `src/distill/training-worker-adapter.js`, `src/distill/promotion-gate.js`, and `docs/internal/distill-state-machine.json`.
CODE: distill states must be `draft`, `corpus_ready`, `policy_checked`, `worker_queued`, `training`, `eval_running`, `eval_failed`, `eval_passed`, `artifact_built`, `promotion_blocked`, `production_ready`, and `retired`.
CODE: `fixture_only`, `collect_only`, and `full_train` must be separate execution modes with separate environment guards. A route or account button cannot accidentally call fixture behavior while claiming a trained artifact.
CODE: teacher policy must classify source as `open_weights`, `proprietary_api`, `customer_owned`, `synthetic`, or `unknown`, and record TOS risk, allowed distillation purpose, model version, provider retention policy, and required customer acknowledgment before training starts.
CODE: promotion requires disjoint holdout, dataset rights, redaction and poisoning status, teacher source policy, K-score scope, model card, artifact signature, runtime target, rollback plan, and account-visible evidence.
EXIT: distillation can be debugged and audited phase by phase, and no student model is promoted from ambiguous data or ambiguous teacher rights.

REDLINE: compile IR and native compile are useful, but compilation is not yet a full compiler product with IR versions, lowering passes, diagnostics, and target backends.
ACTION: CREATE `src/compiler/kolm-ir.js`, `src/compiler/pass-manager.js`, `src/compiler/diagnostics.js`, `src/compiler/lowering-targets.js`, `src/compiler/target-artifact.js`, `docs/internal/compiler-pass-pipeline.json`, and `public/account/compiler.html`; WIRE `src/compile-ir.js`, `src/workflow-ir.js`, `src/native-compile.js`, `src/spec-compile.js`, `src/compile-targets.js`, exporters, artifact builder, and docs.
CODE: compile pipeline must have explicit passes: `trace_import`, `privacy_redaction`, `workflow_ir_build`, `coverage_analysis`, `determinism_analysis`, `tool_boundary_analysis`, `shape_inference`, `target_selection`, `runtime_lowering`, `native_optional_compile`, `artifact_bundle`, `verify`, and `emit_evidence`.
CODE: each pass emits diagnostics with severity, source span, tenant-safe message, machine code, suggested fix, blocked promotion flag, evidence id, and owning file. Passes cannot throw raw exceptions to account/API/CLI.
CODE: lowering targets must declare whether they are `workflow_capsule`, `compiled_rule`, `distilled_model`, `tool_agent`, `code_assistant`, `onnx`, `gguf`, `mlx`, `coreml`, `executorch`, `tensorrt`, `wasm`, or `kserve_llmservice`, and what semantics are preserved or lost.
EXIT: "compiler" means users can see IR coverage, pass diagnostics, target lowering, and exact reason a build can or cannot run anywhere.

REDLINE: quantization oracle is currently a constraint solver and method catalog; it is not yet the best quantization tool until it closes the loop with measured per-layer evidence.
ACTION: CREATE `src/quant/quantization-executor.js`, `src/quant/layer-sensitivity.js`, `src/quant/activation-profiler.js`, `src/quant/quant-debugger.js`, `src/quant/rollback-selector.js`, `docs/internal/quantization-evidence-contract.json`, and `public/account/quantization.html`.
CODE: quantization must execute an evidence loop: baseline run, calibration capture, layer/tensor sensitivity, candidate method selection, conversion, smoke, eval, runtime benchmark, failure localization, rollback artifact, and recommendation.
CODE: every layer/tensor decision records source dtype, target dtype, block size, scale granularity, outlier handling, calibration rows, saturation rate, activation drift, logit delta, K-score delta, memory delta, latency delta, and whether the layer was excluded.
CODE: method support must separate `planned`, `worker_available`, `external_toolchain_required`, `runtime_policy_only`, `unsupported_target`, and `measured_production_ready`. Catalog entries like AWQ/GPTQ/SmoothQuant/HQQ/KV-only compression cannot be shown as shipped unless executor evidence exists for the target runtime.
EXIT: Kolm can recommend quantization because it measured the artifact on the target, not because a catalog said the method is plausible.

REDLINE: TSAC and ITKV currently ship profile schemas and heuristics, but the runtime dispatch path is future-scoped in comments.
ACTION: CREATE `src/runtime/attention-runtime-dispatch.js`, `src/runtime/kv-runtime-dispatch.js`, `src/runtime/tsac-telemetry-collector.js`, `src/runtime/itkv-cache-manager.js`, `docs/internal/attention-kv-runtime-contract.json`, and `reports/runtime-attention/<run-id>/evidence.json`.
CODE: TSAC cannot be production-enabled until attention telemetry is collected from real runs, sparse profiles are validated against dense fallback, and quality guards record logit delta, K-score delta, schema failure delta, and task class.
CODE: ITKV cannot be production-enabled until token classes are produced by the tokenizer/runtime, precision tiers are applied by a runtime backend, cache hits/misses are measured, and citation precision is compared against non-tiered KV.
CODE: both systems must support `disabled_no_telemetry`, `enabled_shadow`, `enabled_guarded`, `fallback_dense`, `fallback_full_precision`, and `blocked_safety_task`.
EXIT: sparse attention and tiered KV become safe runtime optimizations with live dispatch and rollback, not static profiles.

REDLINE: confidence routing and speculative teacher decoding are separate features even though both choose when a student and teacher cooperate.
ACTION: CREATE `src/runtime/student-teacher-policy.js`, `src/runtime/student-teacher-evidence.js`, `src/runtime/student-teacher-budget.js`, `docs/internal/student-teacher-runtime-contract.json`, and `public/account/student-teacher-routing.html`.
CODE: policy modes must be `student_only`, `teacher_only`, `confidence_escalation`, `student_draft_teacher_verify`, `teacher_council`, and `blocked_no_evidence`.
CODE: every decision records logprobs availability, entropy threshold, calibration version, acceptance rate, token spans, teacher calls avoided, teacher calls made, cost saved, latency saved, quality risk, fallback reason, provider capability gap, and customer policy reason.
CODE: if a provider lacks logprobs or teacher verification support, the decision must say `no_entropy_signal_available` or `teacher_verify_unavailable` and route through an honest fallback. It cannot imply confidence routing is active.
EXIT: hybrid inference is one measurable student-teacher system that can optimize cost, quality, and latency without overclaiming unsupported provider capabilities.

REDLINE: OpenAI-compatible completions are a valuable wedge, but the endpoint is not complete until it is tied to the engine state, trust policy, model catalog, runtime selection, and usage accounting.
ACTION: CREATE `src/api/openai-compatible-contract.js`, `src/api/completion-runtime-adapter.js`, `src/api/completion-stream-contract.js`, `docs/internal/openai-compatible-surface.json`, and `public/account/api-traffic.html`; WIRE `src/completions-api.js`, router endpoints, provider adapters, runtime policy, trust control plane, billing usage, event capture, and SDK docs.
CODE: every chat/completions response must record selected model, fallback chain, runtime backend, capture status, privacy status, trust decisions, route decision, usage tokens, estimated cost, artifact provenance when applicable, request id, and engine run id.
CODE: streaming must preserve the same metadata by emitting start, delta, tool, finish, error, usage, and evidence events without leaking secrets or breaking OpenAI SDK compatibility.
CODE: fallback chains must respect tenant policy, data residency, model capability, cost ceiling, latency SLO, modality, structured-output support, and provider terms. A fallback that violates policy is not attempted.
EXIT: "drop-in OpenAI replacement" becomes a governed traffic product, not only protocol compatibility.

REDLINE: model/runtime/provider capability truth is still too spread out to power placement, pricing, docs, account UI, and engine decisions reliably.
ACTION: CREATE `src/catalog/capability-authority.js`, `src/catalog/model-row.js`, `src/catalog/runtime-row.js`, `src/catalog/provider-row.js`, `src/catalog/capability-freshness.js`, `public/capabilities/engine-capabilities.json`, and `docs/internal/capability-authority-contract.json`.
CODE: each row must declare modalities, context, logprobs, tool calls, structured output, streaming, batch, embeddings, rerank, vision, audio, video, reasoning, cost, rate limits, data retention, residency, ToS constraints, distill eligibility, runtime export eligibility, quantization eligibility, benchmark coverage, last verified date, and source of truth.
CODE: engine decisions cannot read ad hoc provider/model strings. They must call capability authority and record the row id and version in evidence.
EXIT: placement, routing, docs, pricing, SDK examples, and account pickers all use the same capability truth.

REDLINE: KServe/Kubernetes deployment is not complete until Kolm can emit and reconcile production serving objects, not just describe cloud targets.
ACTION: CREATE `src/deploy/kserve-renderer.js`, `src/deploy/kserve-reconciler.js`, `src/deploy/serving-runtime-renderer.js`, `docs/internal/kserve-deployment-contract.json`, and `public/account/kubernetes-serving.html`; WIRE deployment targets, object storage, model/artifact registry, runtime placement, cloud readiness, and rollback.
CODE: deployment output must include `InferenceService` or `LLMInferenceService`, `ServingRuntime`, storage URI, runtime image, resource requests, autoscaling policy, canary weights, readiness/liveness probes, data residency labels, secret references, artifact digest, trust bundle, and rollback target.
CODE: reconcile loop must report desired vs observed state, pod readiness, model load status, runtime health, route URL, autoscaler status, last failure, canary split, and evidence id.
EXIT: enterprise "run anywhere" includes Kubernetes-native serving objects with operational state and rollback.

REDLINE: code completion and engineering agents require an engine path equivalent to compile/distill/runtime, not just separate IDE files.
ACTION: CREATE `src/engine/code-engine-adapter.js`, `src/code/context-indexer.js`, `src/code/repo-policy-engine.js`, `src/code/code-artifact-builder.js`, `docs/internal/code-engine-contract.json`, and `public/account/code-engine.html`.
CODE: code-engine runs must ingest editor events, build a privacy-filtered context graph, decide local/cloud provider, produce completions or patches, capture accept/reject/test outcome, feed approved rows into distillation, and compile a repo/team-scoped code artifact with eval evidence.
CODE: code context must be represented as AST symbols, diagnostics, dependency graph, test graph, recent edits, file windows, and policy exclusions. Raw repository upload is a separate explicit mode, never the default.
CODE: engineering-agent patch mode must use sandboxed worktrees, unified diff validation, command evidence, changed-file ownership, destructive-operation blocklist, secret scanning, and human approval before applying to a real workspace.
EXIT: code completion is one of Kolm's product loops with capture, distill, artifact, runtime, trust, and account evidence.

REDLINE: benchmarking the product engine cannot be a collection of route tests; it must reproduce the business metrics Kolm sells.
ACTION: CREATE `src/engine/engine-benchmark-harness.js`, `docs/internal/engine-benchmark-scenarios.json`, `reports/engine/<run-id>/engine-benchmark.json`, and `public/benchmarks/engine.html`.
CODE: benchmark scenarios must include `openai_drop_in_route`, `capture_to_artifact`, `distill_customer_task`, `quantize_for_device`, `run_local_vs_cloud`, `student_teacher_cost_saving`, `structured_output_reliability`, `code_completion_private_local`, and `kserve_deploy_rollback`.
CODE: each scenario records setup, dataset, model/provider, artifact, runtime, hardware, environment, exact commands, p50/p95/p99 latency, throughput, cost, quality, K-score, failure rate, trust blocks, customer-visible next action, and reproducibility hash.
EXIT: every product claim maps to a scenario with numbers, proof, and failure examples.

## Current State From The Worktree

Observed current state:

| item | current evidence | meaning |
|---|---|---|
| Git state | `package.json` and `.vercelignore` modified; many untracked files | Not clean. No finality claim is possible. |
| Scratch artifacts | `.w850-shots/`, malformed `site-failures*.txt`, local data temp files | Must be moved, archived, ignored, or deleted before a clean release. |
| Internal control files | `docs/internal/*.json` exists and is untracked | Good direction, but not finished until tracked/owned or intentionally ignored and wired into gates. |
| Control scripts | `build-codebase-file-ledger`, `build-design-cascade-ledger`, `build-wave-registry`, `build-catalog-manifest`, `build-product-media-proof` exist and are untracked | These need review, ownership, tracking, strict mode, and release integration. |
| Missing control scripts | no `build-account-product-matrix`, no `build-final-redline`, no `build-production-evidence`, no `build-page-family-contracts`, no `build-claim-copy-map` found | Core finish machinery is incomplete. |
| `verify:depth` | does not include `verify:control-files` | Control files can drift while depth still passes. |
| `src/router.js` | 953,495 bytes | Too large to call finished without route ownership, splitting, or generated route module boundaries. |
| `cli/kolm.js` | 2,021,134 bytes | Too large to call finished without command ownership, modularization, and generated help/doc parity. |
| `public/index.html` | 214,568 bytes | Homepage still carries large legacy/test/proof payload risk. |
| `public/pricing.html` | 103,817 bytes | Pricing page needs canonical billing/source-of-truth ownership. |
| `public/account/overview.html` | 36,970 bytes | Account command center exists but must be proven against the whole product matrix. |
| file ledger output | `total_paths=3673`, `dirty_paths=24`, `untracked_paths=22`, `failures=2` | The repo already knows it is not final. |
| product media proof output | `local_missing=0`, `img_dimension_gaps_baseline=4`, external `kolm.ai` references `1099` | Media proof improved, but canonical ownership and page-level product usefulness still need code closure. |

Continuation scan from this pass:

| scan | result | redline |
|---|---:|---|
| PowerShell file enumeration excluding `.git` and `node_modules` | `123444` files | The workspace contains large generated/scratch/build output; release-relevant ledgers must classify what counts. |
| Generated codebase ledger | `3673` total release-relevant paths | Use the generated ledger as the source for release cleanup, not raw filesystem count. |
| Public HTML from design ledger | `729` files | UI consistency cannot be proven page-by-page by hand; page-family contracts are required. |
| Account HTML pages | `41` files | Post-auth product matrix cannot be complete until every page has journey/state/API ownership. |
| Public CSS files | `24` files | CSS architecture is fragmented and must be collapsed into canonical layers. |
| Design cascade ledger | `3215` inline HTML styles, `652` style tags, `3873` CSS `!important`s, `155` viewport-scaled font sizes, `75` negative letter-spacing uses | This is a design-system code debt, not a screenshot-only issue. |
| Redline-term scan | `797` hits across `1616` scanned code/doc files | Not every hit is bad, but every public/mock/placeholder/coming-soon path needs classification as fixture, honest local mode, or product debt. |
| Wave registry | `551` waves, `450` local green, `93` planned, `323` test-only waves, `93` plan-only waves | The roadmap is not complete code until test-only and plan-only waves are reconciled to real product behavior or retired. |
| Package scripts | `verify:control-files` exists but is not in `verify:depth`; `verify:account-product-matrix`, `verify:final-redline`, `verify:production-evidence` are missing | Final completion gates are not wired. |
| API route inventory | `582` generated route entries: `284` GET, `276` POST, `13` DELETE, `7` PUT, `2` PATCH | Route count alone is not enough; each route needs owner, auth, envelope, rate limit, examples, and production smoke. |
| API auth metadata in generated route inventory | `auth_shapes={"":582}` | Generated API docs do not prove auth/tenant policy; auth metadata must be encoded and verified per route. |
| Largest API groups | `/v1/account=19`, `/v1/capture=14`, `/v1/teams=12`, `/v1/distill=11`, `/v1/marketplace=11`, `/v1/team=11` | High-value route groups need product-surface, tenant, and authorization contracts first. |
| Account page API scan | `41` pages; zero direct `kfetch`/literal `fetch` calls found on `ab-tests`, `active-learning`, `bakeoff`, `captures`, `confidence`, `continuous-monitoring`, `multimodal-bakeoff`, `pipelines`, `routing`, `sustainability` | These pages may be static, template-driven, or incomplete; each needs a matrix classification and state contract. |
| Account auth signal scan | `public/account/pipelines.html` did not show an obvious auth/kfetch/signin signal in the quick scan | This page needs explicit classification as live account surface, reference page, generated report, or archive. |
| Security-sensitive code scan | `11133` broad hits for env/secrets/tokens/process/spawn/tenant/security terms | The number is broad, but it proves a final release needs a real security inventory, not ad hoc review. |
| Product graph | `12` journeys, `582` routes, `163` route groups, `64` CLI commands, `32` TUI views, `33` account links, `57` readiness requirements | The graph is the right spine, but final completion requires every public/account/docs route to be attached to this spine. |
| Readiness closeout | `8` open requirements: `2` external partner, `1` live certification, `4` package release, `1` public benchmark data | Copy and product UI must keep these visibly scoped until external proof exists. |
| SEO/accessibility metadata quick scan | `729` public HTML pages; `462` titles match the old non-ASCII separator pattern; `152` descriptions exceed 165 characters; `8` pages lack H1 | Search and accessibility polish is not done. Browser tabs/social snippets still need canonical metadata generation. |
| Main/skip-link quick scan | `4` public HTML pages lack obvious `<main>` or skip-link coverage: `public/account/pipelines/index.html`, `public/account/pipelines/_template.html`, `public/security/membership-inference.html`, `public/design-system.html` | Page templates still need accessibility closure. |
| Public nav asset | `public/nav.js` is `49 KB`; `public/site.js` and `public/account-nav.js` are missing | Navigation is centralized partly, but account/docs/page-family ownership needs explicit generated contracts. |
| Public discovery assets | `public/sitemap.xml` `64 KB`, `public/llms.txt` `15 KB`, `.well-known/ai-context.json` `3.6 KB`; `public/ai-context.json` missing | AI/search discovery exists but needs generation ownership and consistency checks. |
| GitHub workflows | `11` workflows; `8` lacked explicit top-level permissions in quick scan; `0` had concurrency; `0` had OIDC/provenance indicators; `0` appeared SHA-pinned | CI/CD is not release-grade until permissions, pinning, provenance, and concurrency are deliberate. |
| Composite GitHub actions | `4` local composite actions with shell steps | Local actions are product distribution surfaces and need shell safety, input validation, and versioning. |
| Package manifests | `9` package manifests under `packages/` and `sdk/`; only `4` showed test scripts; only `3` showed build scripts; all quick-scanned `publishConfig` values were null | SDK/package readiness is mixed and cannot be marketed as fully shipped package channels. |
| SDK/build artifacts | `sdk/` contains `4956` files and about `1.59 GB`; largest files are under `sdk/rust/target` | Build outputs are in the working tree and must be ignored, cleaned, or explicitly treated as generated artifacts outside release source. |
| Deploy config | `vercel.json` is `57 KB`, `.vercelignore` exists, `railway.toml` exists, `Dockerfile` exists | Deployment topology must be documented and generated enough to avoid route/include/exclude drift. |
| Local env files | `.env`, `.env.cloudflare`, `.env.local`, and copies under `tmp/kolm-launch-*` exist in the worktree | Final release must prove no live secrets or local env files leak into git, deploy bundles, reports, or public assets. |
| Local data tree | `data/` contains `3576` files, about `752 MB`, `3178` JSON files, `1` SQLite DB, and `376` backup/temp files | Data lifecycle, retention, tenancy, and release exclusion are not optional cleanup items; they are product correctness. |
| Largest local data files | `observations.json` and `.bak` are each about `174 MB`; two temp observation files are about `174 MB` each; `kolm.sqlite` is about `37 MB` plus WAL/SHM | Capture/lake data and local backups must be classified as fixture, local state, production data, or disposable scratch. |
| Persistence/lifecycle code scan | `8320` broad hits; highest files include `src/router.js`, `src/store.js`, `src/audit-retention.js`, `src/teams.js`, `src/audit-export.js`, `src/event-store.js`, `src/auth.js`, `src/billing-upgrade.js`, `src/data-residency.js` | The repo has real persistence/lifecycle logic, but final completion requires a single data inventory and state-machine contract. |
| Mutating routes | `298` generated route entries are mutating (`POST`, `PUT`, `PATCH`, `DELETE`) | Mutations need idempotency, audit, tenant authorization, rollback/compensation, validation, and user-visible failure states. |
| Lifecycle route terms | route inventory includes `account=19`, `team=27`, `audit=11`, `privacy=7`, `export=9`, `storage=5`, `lake=9`, `capture=26`, `billing=4`, `delete=1`, `purge=1` | Customer lifecycle, privacy rights, export/delete/purge, and billing plan changes need explicit product and compliance contracts. |
| AI capability files | `287` files matched distill/compile/runtime/device/model/provider/benchmark/eval/artifact/capture terms, about `19.7 MB` | Kolm's core AI product surface is broad enough that it needs its own capability completion matrix. |
| AI capability routes | route inventory terms include `capture=26`, `distill=18`, `eval=14`, `device=14`, `bench=13`, `bakeoff=10`, `compile=9`, `runtime=8`, `artifact=8`, `model=9`, `quant=3`, `inference=1` | The three product surfaces exist in routes, but each route group needs an end-to-end product proof contract. |
| Catalog manifest | `132` entries: `51` local models, `34` provider models, `25` devices, `14` hardware entries, `4` providers, `4` runtimes; `115` available and `17` candidate | Catalog truth is useful but not enough for "run anywhere" or model-agnostic claims until provider/runtime freshness and proof are enforced. |
| Compute registry | `21` backends updated `2026-05-14`: local CPU/CUDA/MPS/MLX/ROCm/DirectML/OpenVINO/QNN, Modal, RunPod, Together, Vast, SSH, Lambda, Replicate, Fal, Anthropic, vLLM, SGLang, TGI, TRT-LLM | Compute breadth must be tied to readiness, credentials, smoke, cost, legal/provider terms, and failure states. |
| Missing model catalog files | `src/model-catalog.js`, `src/model-manifest.js`, `public/models.json`, and `public/provider-models.json` missing in quick check | Model/provider truth appears split across generated catalog and route logic; final code needs one canonical model catalog surface. |
| AI capability scope scan | `644` broad hits for placeholder/mock/stub/synthetic/heuristic/benchmark/external language in AI-capability source files | Many are intentionally honest, but final product UI must surface which results are real, heuristic, simulated, local-only, or benchmark-gated. |
| Public AI pages | `81` public AI/product pages quick-scanned had proof-or-CTA signals; broader AI-doc/page match was `350` pages | The public content footprint is large; every AI feature page must map to feature status, proof asset, and claim scope. |
| Release-relevant source by directory | `src=392 files/6.26 MB`, `cli=2/1.95 MB`, `apps=128/1.03 MB`, `workers=43/0.33 MB`, `public=1133/61.63 MB`, `scripts=347/24.81 MB`, `tests=567/6.98 MB` excluding obvious build/cache directories | Kolm is not "just JS." The finish plan must cover Node, browser HTML/CSS/JS, Python trainer/runtime/export/import code, Workers, SDKs, services, scripts, CI, and deploy config. |
| Python app surfaces | `apps/capture`, `apps/data`, `apps/eval`, `apps/export`, `apps/import`, `apps/modal`, `apps/replicate`, `apps/runtime`, `apps/trainer`, `apps/showcase` | These are product runtime surfaces. They need ownership, packaging, lint/build/test, environment contracts, artifact boundaries, and docs parity before completion. |
| Worker surfaces | largest workers include `workers/quantize`, `workers/distill`, `workers/compile-server`, `workers/runtime-build`, `workers/vision-tokenize`, `workers/audio-tokenize`, `workers/video-tokenize`, `workers/multimodal-redact-*`, `workers/tsac`, `workers/itkv` | Worker code must be promoted from optional experiments into installable, observable, resource-capped services or explicitly scoped as labs/reference code. |
| Worker package contracts | `@kolm/distill-worker` exposes `doctor`, `collect`, and `stub`; `@kolm/quantize-worker` exposes `doctor`; compile-server has Docker/Helm but no package manifest in quick check | Real worker finish means each worker has one command surface: doctor, run, smoke, package, container, healthcheck, telemetry, and failure output. |
| Python dependency surfaces | `apps/trainer/pyproject.toml` has core and GPU extras; Modal and Replicate requirement files pin heavy ML stacks | Python environments must be reproducible and isolated from the root Node install; GPU/toolchain availability must be detected honestly. |
| Checked-in cache/build artifacts | `*.pyc=88`, `*.bak=389` about `177.74 MB`, `*.tmp=2` about `330.83 MB`, `*.log=442`, SQLite WAL/SHM files present | This is not final release hygiene. Build/cache/temp/local state must be ignored, quarantined, or transformed into intentional release artifacts. |
| Archive and snapshot footprint | `archive/prod-snapshot-2026-05-22` contains many full public pages and generated assets | Archive snapshots must not be confused with live product truth or shipped pages; final build needs a page registry that excludes archived surfaces. |
| Worker/service source hot spots | `workers/quantize/scripts/quantize.py`, `workers/distill/distill.mjs`, `workers/compile-server/server.mjs`, `services/mcp/server.js`, runtime/trainer Python modules | These need manual code review and real local usage, not just green root tests, because they are where "compile/distill/run anywhere" either becomes true or fails. |
| Tracked non-archive Kolmogorov string scan | `git grep -i kolmogorov` excluding archive/node_modules/data/reports/screenshots still returned about `1980` tracked matches | The current brand gate is too narrow for a "Kolm only" final release; public/docs/package/repo identity is not closed. |
| Backend-owned brand test scope | `tests/wave594-kolm-brand-contract.test.js` scans `server.js`, `package.json`, selected docs, and roots `cli`, `src`, `scripts`, `packages`; it does not cover all public/docs/account pages | Existing brand verification can pass while public docs still show old install commands and repository slugs. |
| Root package identity | root `package.json` is `name: "kolm-stack"`, `private: true`, and exposes bin `kolm` | Public install copy must not imply a published root npm package unless the package is actually publishable and smoke-tested. |
| Package identity spread | package names include `kolm`, `kolm-attestation`, `@kolm/langchain`, `@kolm/llamaindex`, `kolm-rn`, `@kolm/recipe-mcp`, `@kolm/kolm-sdk`, worker packages under `@kolm/*`, and VS Code names | This may be acceptable only if it is deliberate; final code needs a package identity matrix with canonical names, aliases, publication state, and docs commands. |
| Legacy public install commands | public docs still include examples such as `@kolmogorov/sdk`, `@kolmogorov/mcp`, and `@kolmogorov/cli` in tracked files | Developer experience is not finished while docs tell users to install package names that do not match canonical package metadata. |
| Legacy repository links | many tracked public/account/docs pages link to `https://github.com/sneaky-hippo/kolmogorov-stack` | If final product identity must be Kolm-only, repository URL, footer links, issue links, schema metadata, install fallbacks, CloudFormation, and generated docs must be migrated or centralized behind an approved canonical constant. |
| Existing historical matrices | older research CSVs already identify package-name chaos around `@kolmogorov/*`, `kolmogorov-stack`, and unpublished SDK packages | Do not leave these as historical notes; promote the still-current parts into the package identity matrix and close them in code/docs. |
| Build/generator script inventory | script prefixes quick-counted as `build=32`, `audit=15`, `simulate=10`, `bench=6`, `verify=4`, `release=1`, `local=2`, `prod=2`, `package=1`, `other=213` | The build is already a product surface. It needs a generated build graph, not scattered scripts and hand-maintained command chains. |
| Generated internal ledgers | `docs/internal/` currently contains `catalog-manifest.json`, `codebase-file-ledger.json`, `design-cascade-ledger.json`, `product-media-proof.json`, `wave-reconcile-report.json`, `wave-registry.json`, and `wave-registry.schema.json` | Good start, but still missing source-boundary, build-graph, generator-registry, generated-artifact, account, page-family, claim-copy, brand/package, runtime, and final-redline ledgers. |
| Generator attribution coverage | `scripts/build-codebase-file-ledger.cjs` uses a small hand-maintained `GENERATED_BY` array; quick inspection found many write scripts outside that list | A final codebase cannot rely on partial output attribution. Every generated artifact must name its generator, inputs, owner, determinism policy, and release inclusion. |
| Generated artifact write surface | write-operation scan found generators and mutators such as `build-account-pages.cjs`, `build-api-ref.cjs`, `build-openapi.cjs`, `build-docs-w374.cjs`, `build-og.cjs`, `build-sitemap.cjs`, `add-twitter-card.cjs`, `fix-*`, `inject-*`, `brand-*`, screenshot scripts, and archive scripts | One-off mutation scripts are now release risks. They must be promoted to idempotent generators, labeled migrations, or retired. |
| Package script build shape | `build:control-files` covers five ledgers; `verify:depth` is a long hand-written shell chain; no `build:all`, `verify:build-graph`, or generated dependency scheduler exists | The repo can still run builders out of order, omit required generators, or race generated files. A deterministic build orchestrator is mandatory. |
| Known generation race class | earlier API/OpenAPI regeneration raced when route docs were being written while OpenAPI read them | Dependent generators must be serialized by the build graph, with `build-api-ref` before `build-openapi` and every consumer declaring input files explicitly. |
| Report output sprawl | `reports/ui-surface-audit/*/report.json` contains many large generated reports in the tree | Reports need retention, release-inclusion, evidence, and expiry classification so old screenshots/reports cannot masquerade as current product proof. |
| CLI top-level product use | `node cli/kolm.js --help` prints a coherent product loop but also exposes a very large command surface; first screen listed gateway, capture, privacy, datasets, evals, train/distill, runtime, govern plus dozens of commands | The product is powerful but not finished as an operator UX until there are three guaranteed golden paths that hide internal complexity by default. |
| Quickstart UX | `kolm quickstart --help` exposes only `wrapper` and `studio` paths | The quickstart does not yet map cleanly to all three business surfaces: route/capture, distill/compile, and run/govern/device. |
| First-run artifact build | A temp `kolm build redline-smoke --from classifier --yes --json` produced a `.kolm` artifact but exited non-zero because `production_ready=false` from placeholder seed provenance and under-sized split | Honesty is good, but first-run UX must separate "artifact built", "sample only", "not production ready", and "next step to real data" into a more actionable path. |
| First-run K-Score output | Build output showed high sample K-score but `human_preference_rate=null`, `calibration_pack_id=null`, and `calibration_status=no_calibration_mapping` | K-Score UI/CLI/docs must never let sample/template scores feel like validated quality. |
| `kolm next --json` | Returned local recommendations from existing local state and emitted experimental WASI/SQLite warnings to stderr | Recommendations need provenance, workspace scope, freshness, and warning handling so operator guidance feels intentional and trustworthy. |
| Storage readiness use | `kolm cloud storage --json` showed only `local-artifacts` configured and cloud providers missing credentials in this shell | Cloud/account/docs must clearly separate local success from cloud readiness; no page should imply hosted artifact storage is configured without env-backed proof. |
| Account file inventory | `41` account HTML pages under `public/account` | The post-auth product is large enough to need a generated account shell and state machine, not page-by-page hand edits. |
| Account title separators | `15` account pages still contain the bad `U+7E5A` separator in quick scan | Mojibake is still present in browser-tab/social metadata for post-auth surfaces. |
| Account skip links | `34` account pages contain two visible source occurrences of "Skip to content" | Duplicate skip-link systems indicate shell drift and can confuse keyboard/screen-reader flow. |
| Account inline styles | all `41` account pages contain inline `style=` attributes; quick count found high offenders like `agent-telemetry=40`, `storage=28`, `overview=18`, `failure-modes=16` | Account visual system is not finished as a component system; important layout/state styles still live inside individual pages. |
| Account top nav drift | `39` account pages quick-scanned with hardcoded `sneaky-hippo/kolmogorov-stack` links and `Wrapper`/`Studio` top-nav items | Post-auth nav has not been fully realigned to Kolm-only identity or the three product surfaces. |
| Account data wiring | `10` account pages quick-scanned without a literal `kfetch(` call | These pages may be static/reference pages or incomplete live surfaces; each needs generated classification and state contract. |
| Account controls | quick scan found only `2` forms but `102` buttons across account HTML | Buttons need command ownership, disabled/loading/error/success states, keyboard activation, and typed API outcomes. |
| API route inventory parse | Node parsed `public/docs/api-routes.json` as `582` routes across `163` groups; PowerShell `ConvertFrom-Json` failed on the same file in this shell | Generated JSON may be valid for Node but brittle across tools; release artifacts need parser compatibility and corruption/mojibake gates. |
| API route inventory status | `582` routes: `284` GET, `276` POST, `13` DELETE, `7` PUT, `2` PATCH; `298` mutating; `127` route entries are `stub=true`; `127` have no `short` summary | Route count is not completion. Stub and no-summary entries must become scoped product contracts or be removed/archived. |
| Stub-heavy route groups | top stub groups include `ab-tests=6`, `approvals=5`, `cloud=5`, `capture=4`, `drift=4`, `autopilot=4`, plus many multimodal/security/governance groups | High-value product surfaces still have preview/stub route shapes that need implementation or explicit honest scope. |
| OpenAPI security coverage | `public/openapi.json` parsed as OpenAPI `3.0.3`; `586` operations; only `3` operations have `security`; security schemes are `bearerAuth` and `apiKeyAuth` | OpenAPI cannot yet be trusted by customers/SDKs to understand auth, tenant, or permission requirements. |
| OpenAPI request body coverage | `282` mutating OpenAPI operations lack `requestBody` in quick parse | SDK generation, docs, validation, and account forms cannot be considered finished until request schemas exist or absence is intentional. |
| Router error shape | quick scan counted about `1352` `res.status(` uses, `1037` direct JSON error shapes, `0` `errorEnvelope(` uses, `32` `okEnvelope(` and `32` `attachEnvelopeHeaders(` uses | The canonical envelope exists but has not been adopted as the route-wide contract. |
| Router idempotency signal | quick scan found only `3` idempotency string hits across the router | State-changing routes need explicit idempotency policy, replay handling, audit, and client guidance. |

External quality baselines for final code:

| baseline | source | implication for Kolm |
|---|---|---|
| Core Web Vitals require field measurement, not only lab checks; web.dev recommends measuring LCP, INP, and CLS and assessing thresholds for at least 75 percent of page visits. | `https://web.dev/articles/vitals` | Add production RUM for public and account page families; local screenshots cannot prove final UX. |
| WCAG 2.2 adds criteria for focus visibility, target size, dragging movements, consistent help, redundant entry, and accessible authentication. | `https://www.w3.org/TR/WCAG22/` and `https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/` | Account and pricing/signup flows need keyboard, focus, target-size, form, and authentication accessibility contracts. |
| SLSA v1.2 defines build/source tracks and provenance concepts for stronger supply-chain guarantees. | `https://slsa.dev/spec/v1.2/` | Final production evidence should include artifact provenance and release verification, not just a deploy URL. |
| OWASP API Security Top 10 2023 includes broken object/function/property authorization, unrestricted resource consumption, sensitive business flows, SSRF, misconfiguration, improper inventory, and unsafe API consumption. | `https://owasp.org/API-Security/editions/2023/en/0x00-header/` | Every `/v1/*` route must declare tenant object authorization, function authorization, rate limits, SSRF policy, and upstream API trust boundary. |
| OWASP Top 10 for LLM Applications identifies prompt injection, insecure output handling, training data poisoning, model denial of service, supply chain vulnerabilities, sensitive information disclosure, plugin design, excessive agency, overreliance, and model theft. | `https://owasp.org/www-project-top-10-for-large-language-model-applications/` | Capture, distill, agents, registry, tool-use, and runtime features need LLM-specific threat controls before they can be called finished. |
| NIST SSDF SP 800-218 recommends secure development practices to reduce vulnerabilities, mitigate exploitation impact, and prevent recurrence. | `https://csrc.nist.gov/pubs/sp/800/218/final` | Final build redline must require secure-development evidence, dependency/source control, vulnerability handling, and release hardening. |
| OpenTelemetry GenAI semantic conventions define interoperable telemetry for generative AI systems and GenAI spans. | `https://opentelemetry.io/docs/specs/semconv/gen-ai/` | Capture, routing, distill, runtime, agents, and account telemetry should use compatible model/provider/operation/span fields. |
| NIST AI RMF 1.0 is intended to improve the ability to incorporate trustworthiness considerations into AI design, development, use, and evaluation. | `https://www.nist.gov/itl/ai-risk-management-framework` | K-Score, evaluations, model cards, red-team, drift, and governance should map to AI risk functions and evidence. |
| EU AI Act official explorer exposes provisions for prohibited practices, high-risk systems, provider/deployer obligations, transparency, general-purpose AI, enforcement, and dates of application. | `https://ai-act-service-desk.ec.europa.eu/en/ai-act-explorer` | Enterprise/governance pages must classify intended use, deployment context, provider/deployer role, transparency duties, and high-risk/GPAI scope without overclaiming compliance. |
| npm provenance and trusted publishing use provenance attestations and OIDC-based publishing to establish where and how packages were built. | `https://docs.npmjs.com/generating-provenance-statements` and `https://docs.npmjs.com/trusted-publishers` | Public npm packages should use trusted publishing or `npm publish --provenance`, and release evidence should verify attestations. |
| GitHub Actions hardening guidance emphasizes secure workflow practices, action trust, and token/secrets blast-radius control. | `https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions` | Every workflow needs explicit permissions, action pinning policy, safe untrusted input handling, and secrets isolation. |
| OpenSSF Scorecard assesses repository security health with automated checks and scores. | `https://openssf.org/scorecard/` and `https://github.com/ossf/scorecard` | Final release should include a Scorecard run or a mapped equivalent for maintained, pinned dependencies, token permissions, branch protection, and vulnerabilities. |
| CycloneDX provides an SBOM standard for software supply-chain transparency. | `https://cyclonedx.org/` | Final release evidence should include an SBOM for app, CLI, SDKs, Docker image, and generated packages. |
| NIST Privacy Framework is a voluntary tool to help organizations identify and manage privacy risk while building products and services. | `https://www.nist.gov/privacy-framework` | Capture, lake, account, audit, export, delete, retention, and telemetry features need privacy-risk inventory and controls. |
| European Commission GDPR guidance distinguishes controller and processor roles and notes that IT/cloud storage can be processor activity. | `https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/obligations/controllerprocessor/what-data-controller-or-data-processor_en` | Enterprise/account copy and legal docs need role clarity, processor/subprocessor boundaries, and customer data-control workflows. |
| European Commission data-subject-rights guidance includes rights such as deletion, access, portability, and transfer information. | `https://commission.europa.eu/law/law-topic/data-protection/reform/rights-citizens/my-rights/can-i-ask-company-delete-my-personal-data_es` | Account data export, delete, purge, retention, and audit trails must support user/customer rights and show realistic states. |
| OWASP ASVS is an application security verification standard for designing, developing, and testing modern web applications and APIs. | `https://owasp.org/www-project-application-security-verification-standard/` | Auth, session, access control, validation, storage, error handling, API, and file handling should map to explicit verification requirements. |
| PCI DSS v4.0.1 is the active payment-card data security standard referenced by the PCI Security Standards Council. | `https://www.pcisecuritystandards.org/` | Billing must avoid card-data handling unless PCI scope is intentionally designed; Stripe/payment flows need PCI scope documentation. |
| Hugging Face model cards document model description, intended uses, limitations, training parameters, datasets, and evaluation results. | `https://huggingface.co/docs/hub/model-cards` | Kolm artifact/model cards should carry intended use, limitations, provenance, datasets, evals, license, and deployment caveats. |
| MLCommons benchmark work defines representative AI/ML benchmark suites and publishes MLPerf inference results on a regular cadence. | `https://mlcommons.org/benchmarks/` and `https://mlcommons.org/working-groups/benchmarks/inference/` | KolmBench and K-Score claims need transparent rules, datasets, hardware, versions, metrics, and repeatable result submission. |
| ONNX Runtime quantization docs distinguish static calibration, dynamic quantization, supported data formats, and debugging/accuracy considerations. | `https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html` | Distillation-aware quantization must record calibration data, format, target runtime, accuracy deltas, and debugging evidence. |
| vLLM documentation describes high-throughput, memory-efficient serving built around PagedAttention and modern serving features. | `https://docs.vllm.ai/` | Runtime claims should include throughput/latency/memory/KV-cache evidence by backend and workload, not generic "fast inference" copy. |
| Google SRE describes Production Readiness Reviews as a way to identify production reliability needs, including architecture, dependencies, instrumentation, emergency response, capacity, change management, availability, latency, and efficiency. | `https://sre.google/sre-book/evolving-sre-engagement-model/` | Kolm cannot call the build finished until each production service has an owner, SLO, runbook, dependency map, capacity plan, rollback path, and incident response path. |
| DORA's current software delivery metrics cover throughput and instability: change lead time, deployment frequency, failed deployment recovery time, change fail rate, and deployment rework rate. | `https://dora.dev/guides/dora-metrics/` | The final build redline must track delivery health, not just test pass count; repeated hotfixes, deploy failures, or manual recovery keep the codebase below release-grade. |
| CNCF's observability glossary states that observable systems produce meaningful, actionable data from low-level and business signals and that observability affects operating cost. | `https://glossary.cncf.io/observability/` | Production code must emit actionable traces, metrics, logs, costs, and business events for route, capture, distill, compile, runtime, account, billing, and data workflows. |
| npm `package.json` docs define package `name`, `files`, and `bin`; scoped package names use `@scope/name`, and package contents are controlled by `files` plus ignore rules. | `https://docs.npmjs.com/cli/v8/configuring-npm/package-json/` and `https://docs.npmjs.com/about-scopes/` | Kolm install commands, npm package names, CLI bin names, published files, and docs must be generated from one package identity matrix. |
| GitHub repository renames redirect most repository traffic, but GitHub warns that GitHub Pages URLs are an exception and calls to actions hosted by renamed repositories are not redirected. | `https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository` | If the repo moves from `kolmogorov-stack` to a Kolm-only URL, actions, docs, Pages/custom domain, install commands, and old links require an explicit migration plan. |
| PyPA name normalization lowercases Python project names and collapses runs of `.`, `_`, and `-` to `-`. | `https://packaging.python.org/en/latest/specifications/name-normalization/` | Python SDK/package identity must avoid confusing variants such as `kolm`, `kolm-sdk`, `kolm_recipe`, or legacy Kolmogorov names unless aliases are intentional and documented. |
| Reproducible Builds documents `SOURCE_DATE_EPOCH` as a standardized environment variable consumed by build tools to produce reproducible output. | `https://reproducible-builds.org/docs/source-date-epoch/` | Kolm generators, ZIP/tar/package artifacts, Docker image metadata, docs timestamps, and report timestamps need deterministic time handling or explicit nondeterministic classification. |
| SLSA build levels require provenance that identifies how an artifact was built, including build platform, process, and top-level inputs; higher levels add signed and hardened build platform guarantees. | `https://slsa.dev/spec/v1.0/levels` | Final release artifacts need source-to-output provenance for public docs, OpenAPI, SDK packages, Docker images, worker packages, registry packs, and generated screenshots/reports. |
| OpenSSF S2C2F focuses on secure consumption of open source dependencies and pairs with SLSA-style producer provenance. | `https://openssf.org/blog/2022/11/16/openssf-expands-supply-chain-integrity-efforts-with-s2c2f/` | Kolm must prove both sides: how its own artifacts are built and how external packages, model/tool dependencies, Docker bases, and worker dependencies are consumed safely. |
| Command Line Interface Guidelines recommend human-first CLI design, examples-first help, correct exit codes, stdout for primary output, stderr for logs/errors, and discoverable next steps. | `https://clig.dev/` | Kolm CLI completion requires concise default help, structured `--json`, clean stderr warnings, examples per command, and next-action hints that match the product graph. |
| Diataxis organizes docs around four user needs: tutorials, how-to guides, technical reference, and explanation. | `https://diataxis.fr/` | Kolm docs must not be a pile of pages. Each product surface needs one beginner tutorial, one operational how-to, one API/CLI reference, and one explanation page tied to evidence. |
| Twelve-Factor config keeps deploy-varying config such as backing service handles, credentials, and canonical hostnames in the environment rather than code. | `https://12factor.net/config` | Local/cloud readiness should be environment-driven and visible; public/account code must not hardcode deploy secrets, endpoints, or cloud readiness assumptions. |
| Stripe API errors expose typed error categories and request-log context so clients can distinguish temporary, invalid request, idempotency, and payment failures. | `https://docs.stripe.com/api/errors` | Kolm API/account/CLI errors should expose typed failure classes, correlation/request IDs, retryability, and dashboard/account links instead of generic failure copy. |
| WCAG consistent navigation expects repeated navigation mechanisms to appear in the same relative order across a set of pages. | `https://www.w3.org/WAI/WCAG22/Understanding/consistent-navigation.html` | Account, docs, and public nav must be generated or contract-checked so repeated nav order, skip links, sidebars, and breadcrumbs do not drift by page. |
| WCAG focus appearance guidance recommends focus indicators with sufficient size and contrast, with a 2 CSS pixel perimeter as the practical minimum example. | `https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html` | All nav links, account buttons, table actions, filters, disclosure controls, and icon controls need tokenized focus states that survive theme changes. |
| WAI-ARIA disclosure pattern requires disclosure controls to be buttons, toggle with Enter/Space, expose `aria-expanded`, and optionally point to controlled content with `aria-controls`. | `https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/` | Mobile nav, account sidebars, filters, detail drawers, and mega/disclosure menus need keyboard/touch parity, not hover-only or CSS-only behavior. |
| MDN `aria-current` guidance says only one item in a related set should be marked current, with values such as `page` for current page and `step` for multi-step flows. | `https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes/aria-current` | Account sidebars, breadcrumbs, product-step indicators, and nav underlines must use one current item per set and distinguish current page from selected tab. |
| RFC 9457 defines problem details for HTTP APIs and obsoletes RFC 7807; it uses fields such as `type`, `status`, `title`, `detail`, and `instance`, with extension members for machine-actionable details. | `https://www.rfc-editor.org/rfc/rfc9457.html` | Kolm API errors should have a canonical problem/envelope bridge with typed codes, request/correlation instances, retryability, support/account links, and no leaked internals. |
| OpenAPI security schemes and per-operation security requirements are first-class parts of the API description. | `https://spec.openapis.org/oas/latest.html#security-scheme-object` | Every Kolm operation needs generated security metadata; having schemes in `components` is not enough if operations do not declare requirements. |
| Stripe idempotent request guidance is a mature API pattern for safely retrying create/update operations. | `https://docs.stripe.com/api/idempotent_requests` | Kolm mutating routes should declare whether they require, accept, reject, or ignore idempotency keys and how replay conflicts are surfaced. |
| OWASP API1:2023 warns that endpoints receiving object IDs must implement object-level authorization, not just authentication. | `https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/` | Kolm routes with artifact IDs, tenant IDs, team IDs, job IDs, dataset IDs, key prefixes, tokens, tunnels, and storage object names need object-authorization proof. |

## Master Spec Tree

Use this tree as the code-finish authority chain:

| layer | authority | finished-code role |
|---|---|---|
| Archive memory | `docs/research/kolm-ai-100-percent-codebase-completion-blueprint-2026-05-25.md` | Mine for context only. Do not treat as current completion proof. |
| Operating summary | `docs/research/kolm-master-spec-consolidated-review-2026-05-25.md` | Short product and release spine. |
| Code redline | `docs/research/kolm-100-percent-finished-code-redline-2026-05-25.md` | This document. The implementation redline. |
| Internal index | `docs/research/kolm-internal-spec-index-2026-05-25.md` | Classifies internal docs and exit conditions. |
| Generated control state | `docs/internal/*.json` | Machine-readable current state. Must become tracked/owned or intentionally ignored. |
| Final release decision | `reports/build-redline/final-build-redline.json` | Does not exist yet. This is the eventual completion certificate. |

If these disagree, generated control state wins for current facts, this redline wins for what must be fixed, and the archive loses unless a human explicitly promotes an item.

## Live Site/Product Master Spec Redline

Current live product graph: `12` journeys, `8` customization dimensions, `582` routes, `163` route groups, `64` CLI commands, `32` TUI views, `33` account links, and `57` readiness requirements.

Current live account surface: `51` account HTML pages under `public/account/**/*.html`.

Current live design/media ledgers: `729` public HTML pages, `19` CSS files, `3,873` CSS `!important` uses, `1,524` raw CSS hex values, `75` negative letter-spacing uses, `3,215` inline HTML styles, `3,710` media references, `0` missing local media, and `4` image dimension gaps.

REDLINE: the site still has many pages, many account surfaces, and many generated ledgers, but it does not yet have a single live site/product master spec that all pages and account states must obey.
ACTION: CREATE `docs/internal/page-family-contracts.json`, `docs/internal/product-feature-completion-matrix.json`, `docs/internal/account-product-matrix.json`, `docs/internal/site-master-spec.json`, `src/site/page-family-contracts.js`, `src/site/product-page-map.js`, `src/site/structured-data-contract.js`, `public/account/product-command-center.js`, and `scripts/build-site-master-spec.cjs`; WIRE product graph, route contracts, account pages, docs, OpenAPI, catalog manifest, design cascade ledger, product media proof, claim-copy map, and final release evidence.
CODE: the master site spec must expose exactly three user loops:

- `route-and-capture`: `gateway-capture`, `privacy-lake`, `datasets-labeling`; visible through homepage, capture/product/quickstart/API/docs pages, connector/account/lake/dataset pages, and provider/cost/privacy proof.
- `distill-and-compile`: `datasets-labeling`, `train-distill`, `models-backbones`, `multimodal-tokenization`, `compile-verify`; visible through distill/compile/train/models/K-Score/benchmark/spec/runtime pages, build/distill/artifact/bakeoff account pages, and artifact/eval/signature proof.
- `run-and-govern`: `runtime-inference`, `compute-cloud`, `devices-fleet`, `enterprise-governance`, `agents-registry`; visible through run/cloud/BYOC/device/enterprise/security/trust/SDK/integration pages, device/storage/audit/billing/keys/SSO/agent account pages, and deployment/audit/readiness proof.

CODE: every page-family record must declare `family`, `pages`, `loop`, `journeys`, `primary_claim`, `primary_action`, `secondary_action`, `proof_component`, `required_media`, `required_demo_state`, `account_destination`, `docs_destination`, `api_destination`, `cli_destination`, `structured_data_types`, `seo_intent`, `nav_group`, `theme_states`, `mobile_states`, `a11y_requirements`, `core_web_vitals_budget`, `readiness_scope`, and `claim_scope`.
EXIT: homepage, product pages, docs pages, pricing pages, trust pages, comparison pages, vertical pages, and account pages cannot drift into separate stories; every surfaced promise is route/account/docs/proof owned.

REDLINE: generated product media proof currently proves assets exist, not that media communicates product value or supports the active page claim.
ACTION: ADD primary-proof semantics to `docs/internal/product-media-proof.json` via `scripts/build-product-media-proof.cjs` and WIRE key pages to live demo/video/screenshot/product-state proof.
CODE: each key page must declare `primary_media_role` as `live_demo|product_screenshot|workflow_video|artifact_receipt|api_explorer|account_state|diagram_with_data|decorative_only`; `decorative_only` cannot satisfy the proof slot for homepage, product, pricing, docs quickstart, API, SDK, trust, enterprise, or account overview.
EXIT: "image/video/demo elements are trash" becomes a concrete failing state: key pages fail the master spec unless media proves the promised product loop.

REDLINE: design cascade ledger currently measures visual debt, but the site can still ship with raw style sprawl.
ACTION: CREATE `docs/internal/design-token-migration-plan.json` and WIRE it to `docs/internal/design-cascade-ledger.json`.
CODE: every raw hex, `!important`, negative letter-spacing, inline style, and page-local style tag must be classified as `tokenize`, `componentize`, `delete`, `temporary_exception`, or `third_party_required`; exception rows require owner, reason, expiration wave, replacement selector/token, and page-family impact.
EXIT: nav underlines, popouts, button states, colors, fonts, spacing, and theme differences are not subjective feedback anymore; they are owned contract violations with a removal path.

REDLINE: account pages are numerous but not yet a single optimized post-auth product cockpit.
ACTION: CREATE `docs/internal/account-product-matrix.json`, `public/account/product-command-center.js`, `public/account/state-renderers.js`, and `public/account/action-registry.js`; WIRE all `public/account/**/*.html` pages to product graph journey, route contract, and state renderer.
CODE: every account page must implement `loading`, `empty`, `ready`, `partial`, `error`, `unauthorized`, `external_gated`, and `upgrade_required` states; every action button declares route, method, auth, idempotency, audit event, success state, problem state, and docs/CLI equivalent.
EXIT: post-auth account is the product operating system, not a loose set of dashboards.

REDLINE: SEO and AI-discovery metadata cannot be page-local copy because Kolm has three product loops and many page families.
ACTION: CREATE `src/site/metadata-registry.js`, `docs/internal/structured-data-map.json`, and `scripts/build-site-metadata.cjs`; WIRE sitemap, OpenGraph, Twitter cards, JSON-LD, `llms.txt`, `ai-context`, docs metadata, and page titles.
CODE: structured data must generate coherent `SoftwareApplication`, `WebApplication`, `Product`, `FAQPage`, `BreadcrumbList`, and organization identity objects from the same page-family records. Every page gets one canonical intent, one canonical title, one description under snippet budget, one product loop, and one account/docs destination.
EXIT: search snippets, social cards, AI crawlers, and page tabs all describe the same Kolm product instead of fragmented slogans.

## Live API, Docs, And SDK Completion Redline

Current live API evidence:

- `public/openapi.json` is still OpenAPI `3.0.3`.
- `public/openapi.json` has `556` paths and `586` operations.
- `583` OpenAPI operations do not declare operation-level `security`.
- `282` mutating `POST`/`PUT`/`PATCH` operations do not declare `requestBody`.
- `11` operations have no `operationId`.
- `public/docs/api-routes.json` has `582` routes across `163` groups.
- `127` route entries are `stub: true` and have no short/comment documentation.
- `public/docs/api.html` is a 551 KB generated catalog that says `455 reference-ready` and `127 source-indexed`; it is useful as an inventory, but it is not yet a finished API reference.
- `public/sdk-current.json` points to one browser SDK bundle with SRI, but the broader SDK/package tree includes Node, Python, Rust, C, MCP, VS Code, TypeScript, React Native, Swift, Kotlin, browser extension, LangChain/LlamaIndex integrations, Homebrew, winget, apt, and attestation packages.

REDLINE: the API docs are still source-indexed inventory, not a complete API product contract.
ACTION: CREATE `src/api/route-contracts.js`, `src/api/register-route.js`, `src/api/schemas/index.js`, `src/api/problem.js`, `src/api/idempotency.js`, `src/api/object-authorization.js`, `docs/internal/api-contract-matrix.json`, and `scripts/build-api-contract-matrix.cjs`; REPLACE route scraping as the authority for `public/docs/api-routes.json`, `public/openapi.json`, `public/docs/api.html`, SDK fixtures, account action contracts, and CLI examples.
CODE: every route contract must declare `route_id`, `operation_id`, `method`, `path`, `surface`, `journey`, `owner`, `status`, `auth`, `security`, `tenant_scope`, `object_scope`, `rate_limit`, `resource_limit`, `idempotency`, `request_schema`, `response_schema`, `problem_types`, `audit_event`, `account_exposure`, `cli_exposure`, `sdk_exposure`, `docs_exposure`, `production_smoke`, and `claim_scope`.
CODE: route status must be one of `production_contract`, `beta_contract`, `local_only`, `external_gated`, `source_indexed`, `deprecated_alias`, `internal_hidden`, or `remove`. A `source_indexed` route cannot be marketed or SDK-generated.
EXIT: every route has a runtime-enforced contract and the generated API catalog becomes a projection, not the source of truth.

REDLINE: OpenAPI `3.0.3` is not final for Kolm because it prevents modern JSON Schema alignment and hides dialect decisions.
ACTION: CREATE `docs/internal/openapi-dialect-policy.json` and WIRE `scripts/build-openapi.cjs` to route contracts and JSON Schema 2020-12 schemas.
CODE: choose `3.2.0` if the client/tooling path can support it; otherwise pin `3.1.2` with a documented compatibility reason. The emitted spec must include `jsonSchemaDialect`, complete `components.securitySchemes`, per-operation `security` or explicit `security: []`, stable `operationId`, tags from product surface, full request/response schemas, known RFC 9457 problem schemas, streaming/SSE media modeling, file upload/download modeling, webhooks/callbacks where applicable, examples, and `x-kolm-*` extensions for product loop, readiness, account link, CLI command, SDK method, idempotency, object authorization, and production smoke.
EXIT: OpenAPI can generate clients and reference docs without reading `src/router.js`.

REDLINE: mutating operations are not complete while `282` mutating OpenAPI operations lack request bodies and idempotency semantics.
ACTION: IMPLEMENT `src/api/idempotency.js` and require idempotency declaration on every mutating route contract.
CODE: every mutating route is classified as `requires_key`, `accepts_key`, `server_generated`, `rejects_key`, or `non_retryable`; replay storage records method, path, tenant, actor, key, body hash, response hash, status, expiry, and conflict reason. Money, delete/purge, deploy, publish, key rotation, SSO/SCIM, marketplace, billing, and artifact state transitions must not be `not_applicable`.
EXIT: clients and SDKs can safely retry create/update/publish/deploy operations or see an explicit non-retryable problem.

REDLINE: route auth is not API-complete while `583` operations lack per-operation security metadata and object IDs can appear in path/query/body without generated object-authorization proof.
ACTION: CREATE `src/api/security-contract.js`, `src/api/object-authorization.js`, `docs/internal/api-auth-matrix.json`, and `docs/internal/object-authorization-matrix.json`; WIRE route registration, OpenAPI, API docs, account actions, and smoke tests.
CODE: every route declares auth mechanism, required scopes, tenant binding, object id fields, object type, relation/action, plan gate, regional/residency gate, and denial problem type. Object IDs in paths such as artifacts, datasets, keys, jobs, teams, captures, storage objects, deployments, tunnels, invoices, approvals, and agents must call a centralized object authorization decision before handler logic.
EXIT: Kolm closes the OWASP API1/BOLA class by construction instead of relying on route-local checks.

REDLINE: API errors are not complete while route-local JSON envelopes and comment-derived docs coexist.
ACTION: REPLACE route-local ad hoc errors with RFC 9457-compatible problem details from `src/api/problem.js` and WIRE SDK decoding to typed problem classes.
CODE: problem details must include `type`, `title`, `status`, `detail`, `instance`, plus safe Kolm extensions: `code`, `request_id`, `trace_id`, `surface`, `journey`, `retryable`, `next_action`, `docs_url`, `account_url`, `support_ref`, `redaction`, and `secret_values_included:false`. Problem type URLs must resolve to docs and must not leak internals.
EXIT: API docs, SDKs, CLI, and account pages can render failures without string parsing.

REDLINE: SDKs are broad but not proven as generated, parity-checked clients for the complete API surface.
ACTION: CREATE `src/sdk/sdk-contract.js`, `scripts/build-sdk-source.cjs`, `scripts/build-sdk-capability-matrix.cjs`, `docs/internal/sdk-capability-matrix.json`, `docs/internal/sdk-api-parity.json`, `docs/internal/sdk-generation-manifest.json`, and `tests/sdk-generated-client-smoke.test.js`.
CODE: generated clients must include typed requests/responses, typed problem errors, auth helpers, idempotency helpers, pagination helpers, streaming helpers, upload/download helpers, retries, redaction-safe logging, examples, package identity, version binding, and method names derived from stable OpenAPI `operationId`. Handwritten SDKs may wrap generated clients but cannot redefine payloads by hand.
CODE: parity matrix must cover `sdk/node`, `sdk/python`, `sdk/rust`, `sdk/c`, `sdk/mcp`, `sdk/vscode`, `packages/sdk-ts`, `packages/sdk-rn`, `packages/sdk-swift`, `packages/sdk-kotlin`, browser SDK, extension packages, LangChain/LlamaIndex adapters, and installer packages with `source_preview|local_build|package_ready|published|deprecated` state.
EXIT: every SDK page can say exactly which operations it supports, what is generated, what is handwritten, what package channel exists, and how to smoke it.

REDLINE: docs breadth is not the same as docs usability.
ACTION: CREATE `docs/internal/docs-ia-contract.json`, `scripts/build-docs-ia.cjs`, and `public/docs/start/*`; WIRE API reference, CLI reference, SDK docs, tutorials, how-to guides, technical reference, and explanations to product graph journeys.
CODE: docs must follow four user needs: tutorial, how-to, reference, explanation. Each of the three Kolm product loops gets one runnable tutorial, one operational how-to, one generated reference path, and one explanation page. Every code sample declares prerequisites, environment variables, exact command, expected output, cleanup, failure cases, and account/API/CLI equivalent.
EXIT: docs help a developer get first value without reading the route catalog or guessing which product loop they are in.

## Live Product Capability And Build Completion Redline

Current local product-capability evidence:

- The runtime backend is a Node.js/Express application (`server.js` mounts `src/router.js`) with many JS product modules under `src/`.
- The repo is not "only JS": it also has `workers/`, `services/`, multi-language `sdk/` packages, `packages/sdk-ts`, `packages/sdk-python`, `packages/sdk-rn`, `packages/sdk-swift`, `packages/sdk-kotlin`, Rust runtime package, installers, VS Code/MCP integrations, and browser extension packages.
- `docs/internal/` currently contains seven generated control files: catalog manifest, codebase file ledger, design cascade ledger, product media proof, wave reconcile report, wave registry, and wave registry schema.
- `public/product-graph.json` reports 12 journeys, 7 route surfaces, 582 routes, 163 route groups, 69 product API routes, 64 CLI commands, 32 TUI views, 33 account links, 8 customization dimensions, and 57 readiness requirements.
- Readiness status is not all final: 14 shipped, 35 implemented, 2 external-partner gated, 1 live-certification gated, 4 package-release gated, and 1 public-benchmark gated requirement.
- `public/product-readiness-closeout.json` and `docs/readiness-gate-workorders.json` both report 8 open non-local closeout items: foundation standardization, ecosystem runtime adoption, runtime WASM, iOS/Android SDK, benchmarking infrastructure, SDK depth, compliance certification, and one-line install.
- The account tree currently has 51 account HTML pages, while the product graph has only 33 account links. That means account coverage exists, but not every account page is yet owned by a journey/feature/state contract.
- The package scripts now include useful verification lanes (`verify:control-files`, `verify:depth`, product frontier simulations, benchmark gates, package release readiness, UI audits), but the route-contract, SDK-parity, docs-IA, account-matrix, page-family, production-evidence, and final-redline verifiers are still absent.

REDLINE: Kolm is not 100 percent finished while feature completion is inferred from pages, route groups, or tests instead of a product-capability state machine.
ACTION: CREATE `docs/internal/product-feature-completion-matrix.json`, `docs/internal/product-feature-completion-matrix.md`, `scripts/build-product-feature-completion-matrix.cjs`, and `scripts/verify-product-feature-completion-matrix.cjs`.
CODE: build the matrix by joining `public/product-graph.json`, `docs/product-surfaces.json`, `docs/product-journeys.json`, `docs/product-sota-readiness.json`, `docs/readiness-gate-workorders.json`, `docs/internal/codebase-file-ledger.json`, `docs/internal/catalog-manifest.json`, `docs/internal/design-cascade-ledger.json`, `docs/internal/product-media-proof.json`, `public/docs/api-routes.json`, `public/openapi.json`, account HTML pages, CLI help, TUI view inventory, tests, package scripts, SDK/package directories, frontier/invention ledgers, and production evidence when available.
CODE: every feature row must declare `feature_id`, `journey_id`, `route_surface_id`, `stage`, `user_outcome`, `first_value_path`, `source_files`, `runtime_modules`, `account_pages`, `public_pages`, `api_routes`, `cli_commands`, `tui_views`, `sdk_methods`, `docs_pages`, `tests`, `proof_commands`, `uiux_states`, `data_states`, `error_states`, `production_smoke`, `readiness_status`, `claim_scope`, `blockers`, `owner_lane`, and `next_build_cut`.
EXIT: no product feature can be called complete unless this matrix proves its behavior, UI, docs, account flow, API contract, CLI/TUI parity, tests, and production proof.

REDLINE: the 12 journeys must become executable product loops, not just graph rows.
ACTION: FOR EACH journey in `public/product-graph.json`, attach a finished-flow contract:

| journey | finished-flow redline |
|---|---|
| `gateway-capture` | A user can connect or paste an OpenAI/Anthropic/OpenRouter/Gemini-compatible call, see what is captured/redacted/excluded, and generate a compile-ready candidate with API, CLI, docs, account, and receipt proof. |
| `privacy-lake` | A user can inspect capture rows, redaction classes, retention, storage backend, DP aggregate scope, export path, and secret-free readiness in one account flow. |
| `datasets-labeling` | Captures can become datasets with provenance, labels, holdout split, synthetic boundary, reviewer identity, export history, and next distill action. |
| `train-distill` | A user can choose dataset, teacher, student/search strategy, compute target, eval gate, cost budget, failure-mode loop, and signed artifact output. |
| `models-backbones` | Model choice shows source-dated provider/model facts, modality, context, license, cost, memory, runtime target, device fit, and benchmark/readiness scope. |
| `multimodal-tokenization` | Images, PDFs, audio, transcripts, and videos are explicitly supported, unsupported, or gated; each modality has tokenization, redaction, storage, benchmark, preview, and error-state proof. |
| `compile-verify` | Artifacts show spec, model hash, dataset hash, eval gate, signature, quantization profile, runtime targets, dependency graph, receipts, diff, export status, and verification recovery. |
| `runtime-inference` | A signed artifact can run or fail clearly across local, browser, server, MCP, device, hosted, and fallback contexts with latency, cost, memory, target, and receipt evidence. |
| `compute-cloud` | Local, remote GPU, managed train, object storage, BYOC, deployment target, env readiness, cost, and missing-provider state are grouped without exposing secrets. |
| `devices-fleet` | Device detection, target recommendation, install test, runtime compatibility, memory reason, offline/air-gap path, and team tunnel path are visible before deploy. |
| `enterprise-governance` | Tenant, scoped keys, SSO/SCIM status, billing, approvals, audit export, privacy, compliance packet, role boundaries, and certification scope are visible and actionable. |
| `agents-registry` | MCP/tool compilation, agent install proof, registry pinning, telemetry, hashed run logs, permissions, latency, failures, and publish/pull state are first-class. |

EXIT: the public site, account UI, CLI, TUI, API docs, SDK docs, and product graph all tell the same three-loop story: route/capture, distill/compile, run/govern.

REDLINE: account coverage is incomplete until 51 local account pages are classified by product journey, page mode, live data contract, and state model.
ACTION: CREATE `docs/internal/account-product-matrix.json`, `docs/internal/account-product-matrix.md`, `scripts/build-account-product-matrix.cjs`, and `scripts/verify-account-product-matrix.cjs`.
CODE: classify every `public/account/**/*.html` page as one of `live_tenant_dashboard`, `setup_wizard`, `generated_report`, `reference`, `experimental_wave`, `archive`, or `remove`. Every page must declare journey ownership, feature ownership, API routes, CLI/TUI equivalents, primary action, secondary actions, loading/empty/error/partial/success/no-auth/no-credential states, tenant-data safety, secret policy, claim scope, keyboard/mobile/dark/light proof, and local/prod authenticated smoke.
EXIT: there is no orphan account page, and `/account/overview` is a real command center that links the three product loops, readiness closeout, storage/cloud status, billing/plan state, and next actions.

REDLINE: the website cannot feel state-of-the-art while page families, nav, buttons, hero copy, account dashboards, demos, docs, and media are governed only by screenshot pass/fail.
ACTION: CREATE `docs/internal/page-family-contracts.json`, `docs/internal/component-state-contracts.json`, `docs/internal/nav-contract.json`, and `scripts/verify-page-family-contracts.cjs`.
CODE: page families must include homepage/category, product loop, developer/docs, trust/legal, pricing/commercial, comparison, vertical/use-case, account cockpit, demo/media, and article/content. Each family declares first-screen promise, primary CTA, secondary CTA, proof component, media requirement, SEO/structured data, account destination, docs/API destination, allowed density, nav behavior, button variants, state models, accessibility gates, Core Web Vitals budgets, and visual token exceptions.
CODE: use WCAG 2.2 as the accessibility baseline, Core Web Vitals LCP/INP/CLS as performance budgets, OpenTelemetry GenAI conventions for model/runtime telemetry naming, and NIST AI RMF language for risk/governance surfaces. These are implementation constraints, not marketing copy.
EXIT: visual quality is no longer "screenshots looked okay"; it is a page-family and component-state contract with decreasing budgets for raw hex, `!important`, inline styles, negative tracking, hover-only controls, layout shift, missing focus states, missing media dimensions, and unsupported claims.

REDLINE: generated files are now numerous enough that stale or racing generation is a real build risk.
ACTION: CREATE `docs/internal/generated-artifact-manifest.json`, `scripts/build-generated-artifact-manifest.cjs`, and `scripts/verify-generated-artifacts.cjs`.
CODE: each generated artifact must declare source inputs, generator command, check command, downstream consumers, release inclusion, write lock, stale-file behavior, deterministic hash policy, and serial generation order. Include OpenAPI, API routes, CLI docs, SDK version manifest, product graph, readiness closeout, codebase ledger, wave registry, catalog manifest, design cascade ledger, media proof, sitemap, docs manifest, llms/AI context files, screenshots/reports, package manifests, and future matrices.
EXIT: one agent cannot silently break another by regenerating files out of order, and final redline can prove every generated output is current.

## Live Production, Observability, And Release Evidence Redline

Current local production/release evidence:

- `vercel.json` has `49` redirects, `526` rewrites, `52` account rewrites, `108` docs rewrites, and rewrites `/v1/(.*)`, `/health`, and `/ready` to `https://kolmogorov-stack-production.up.railway.app`.
- `vercel.json` defines global security headers, including CSP, HSTS, frame denial, nosniff, referrer policy, and a permissions policy.
- `server.js` uses `helmet`, `compression`, cookie parsing, raw Stripe webhook handling, JSON body limits, explicit static route handlers, and `src/router.js`.
- `src/router.js` exposes public `/health`, deploy `/ready`, authenticated `/v1/health`, admin health, storage/cloud readiness, evidence readiness, package readiness, compliance readiness, and product graph routes.
- `scripts/release-verify.cjs` is a strong local release gate: lint refs, control files, OpenAPI sync, SDK manifest, full tests, SDK smoke, local surfaces, doctor, whoami, artifact verify, and billing tiers.
- `scripts/prod-surface-smoke.cjs` can probe production surfaces against `https://kolm.ai` and supports auth/deep modes.
- `src/otel.js` implements an OTLP/HTTP exporter and `src/router.js` has inference-routing spans, but production evidence does not yet prove OTLP collector configuration, trace delivery, dashboard visibility, alert policy, or incident workflow.
- `reports/` currently contains `95,988` files, almost all under `reports/ui-surface-audit/`; there is no `reports/deployments/`, no `reports/build-redline/`, no `production-evidence.json`, and no `final-build-redline.json`.

REDLINE: local green gates are not production completion.
ACTION: CREATE `reports/deployments/<release-id>/production-evidence.json`, `reports/deployments/<release-id>/production-evidence.md`, `scripts/build-production-evidence-packet.cjs`, and `scripts/verify-production-evidence-packet.cjs`.
CODE: the packet must include release ID, commit, branch, dirty-tree status, deploy target, Vercel deployment URL, Railway service URL, production base URL, API rewrite target, env profile without secret values, generated artifact hashes, release-verify summary, prod public smoke, prod authenticated smoke, storage/cloud readiness, billing/pricing readiness, account auth smoke, screenshot report IDs, Core Web Vitals report, OpenAPI/API-doc route parity, SDK asset hash/SRI, CSP/header verification, telemetry export proof, rollback target, incident/watch window, and signoff decision.
CODE: production smoke must run both public and authenticated paths. It must include `/`, `/product`, `/pricing`, `/docs`, `/quickstart`, `/capture`, `/distill`, `/compile`, `/run`, `/enterprise`, `/security`, `/account/overview`, `/openapi.json`, `/product-graph.json`, `/product-readiness-closeout.json`, `/health`, `/ready`, `/v1/product/graph`, `/v1/evidence/readiness`, `/v1/storage/object-readiness`, `/v1/billing/tiers`, and every surface smoke in `docs/product-surfaces.json`.
EXIT: deploy is not "done" until the live production packet proves the deployed domain, backend, account auth, API, SDK assets, docs, page rendering, headers, readiness, telemetry, rollback, and external-gate scope for the exact release.

REDLINE: observability is not complete while telemetry exists only as optional code and not as release evidence.
ACTION: CREATE `docs/internal/observability-contract.json`, `scripts/build-observability-contract.cjs`, and `scripts/verify-observability-contract.cjs`; WIRE production evidence to it.
CODE: every product journey must declare traces, metrics, logs/events, SLO, alert, dashboard, owner, runbook, data retention, PII/secret redaction, and customer-visible status. HTTP spans must follow OpenTelemetry semantic conventions; GenAI/model spans must use GenAI attributes where applicable; custom attributes must live under `kolm.*` and never leak prompts, secrets, API keys, raw PHI/PII, or model-provider credentials.
CODE: minimum product signals: capture requests, provider routing decision, capture redaction count, dataset split, label queue depth, distill run state, K-Score gate, artifact compile/verify result, runtime latency/cost/quality, fallback reason, storage backend, cloud broker decision, device install result, audit export, billing/usage, SSO/SCIM state, package release readiness, compliance packet state, and readiness closeout state.
EXIT: production incidents can be debugged without reading local logs or asking which product surface owns the route.

REDLINE: release security is not complete while headers exist but security verification is not tied to route contracts, ASVS/API controls, production smoke, and evidence packets.
ACTION: CREATE `docs/internal/security-release-contract.json`, `scripts/build-security-release-contract.cjs`, and `scripts/verify-security-release-contract.cjs`.
CODE: map every public/account/API surface to controls for authentication, authorization, object authorization, rate/resource limiting, CSRF/session/cookie policy, CORS, CSP, secret handling, webhook signature verification, file/media upload policy, SSRF/upstream provider policy, tenant isolation, audit logging, redaction, retention, dependency/SBOM, provenance, vulnerability scanning, and incident response.
CODE: production evidence must record security headers from `https://kolm.ai`, API CORS behavior, authenticated/unauthenticated route behavior, object authorization probes, idempotency behavior for mutating routes, webhook signature behavior, and no-secret report validation.
EXIT: "secure enough to ship" is a traceable contract, not a collection of headers and scattered tests.

REDLINE: the final build cannot be closed without supply-chain provenance and release metrics.
ACTION: EXTEND `reports/build-redline/final-build-redline.json` to include SLSA-style provenance, DORA-style release metrics, generated artifact state, production evidence state, and rollback readiness.
CODE: include build definition, build type, builder identity, source commit, dependency/package lock hash, generated artifact hashes, environment class, tests/gates, deploy start/end, deploy success, lead-time source, change failure indicator, restore/rollback target, incident links, and release notes. This is evidence metadata only; no secret values.
EXIT: a future reviewer can reproduce what shipped, why it was considered safe, how it was deployed, how it was watched, and how it would be rolled back.

## Definition Of 100 Percent Finished Code

The codebase is 100 percent finished only when all of these are true:

1. The release tree is clean or intentionally scoped with a written release manifest.
2. Every tracked, generated, ignored, and untracked path is owned or removed.
3. Every generated artifact has a registered generator, input list, output owner, deterministic check, and release-inclusion decision.
4. Every product feature is implemented end-to-end across API, CLI, UI/account, docs, and production behavior where applicable.
5. Every public and account page is generated from or checked against a canonical product contract.
6. Every route has an owner, auth model, envelope/error contract, OpenAPI entry, and smoke path.
7. Every CLI command has an owner, module boundary, help/docs parity, and no stale hidden behavior.
8. Every UI surface uses the canonical design system or a documented exception with an expiration.
9. Every product-media/demo/video asset is either real product proof, route-owned, accessible, and verified, or removed.
10. Every local-only claim, external benchmark, package release, certification, and partner dependency is scoped in code and copy.
11. Production evidence proves the live deployed commit, env, routes, account auth, screenshots, smoke, rollback, and telemetry.

Anything less is partial.

## What Does Not Count As Finished

These are not completion:

- A green test suite by itself.
- A screenshot audit by itself.
- A generated JSON file by itself.
- A research document by itself.
- A route existing without product ownership.
- A page existing without live states or a declared reference/archive mode.
- A CLI command existing inside a 2 MB monolith with no ownership.
- A media file existing in `public/` without being used as visible product proof.
- Local smoke passing while production is unverified.
- "Implemented" claims for external certifications, package releases, benchmarks, or partner adoption.

## P0 Code Work, In Order

### 1. Stabilize The Worktree

Finish this before broad refactors:

- Decide whether each untracked control script is real code or throwaway.
- Track real control scripts or move them to an ignored scratch area.
- Move or delete `.w850-shots/`.
- Move or delete malformed `site-failures*.txt` paths.
- Delete or quarantine `data/*.tmp` local observation backups.
- Document `.vercelignore` and `package.json` edits as intentional or revert only if they are unrelated and user-approved.
- Produce a release manifest listing every modified and untracked path.

Done when: `git status --short` contains only intentional release files, and every remaining dirty path has an owner and reason.

### 1A. Declare The Backend Runtime Authority

The current backend implementation is Node/JavaScript-heavy: `server.js`, `src/router.js`, `src/*.js`, and `cli/kolm.js` are the active app surface. If the intended canonical backend is something else, that must be reconciled before "finished" can mean anything.

Required work:

- Declare the canonical backend runtime in `README.md`, deployment docs, and package metadata.
- If Node/JS is canonical, stop treating the large JS backend as accidental and refactor it into owned modules.
- If another backend is canonical, create a migration map from each current Node route to the target service and mark the Node route as proxy, legacy, or retired.
- Ensure generated OpenAPI, SDKs, CLI, account pages, and deployment config point to the same runtime authority.

Done when: there is one backend authority, not a mix of assumed runtimes and generated surfaces.

### 2. Promote Control Files From Prototype To Product Code

Current scripts are useful but unfinished until they are reviewed and integrated.

Must finish:

- `scripts/build-codebase-file-ledger.cjs`
- `scripts/build-design-cascade-ledger.cjs`
- `scripts/build-wave-registry.cjs`
- `scripts/build-catalog-manifest.mjs`
- `scripts/build-product-media-proof.cjs`
- `docs/internal/codebase-file-ledger.json`
- `docs/internal/design-cascade-ledger.json`
- `docs/internal/wave-registry.json`
- `docs/internal/catalog-manifest.json`
- `docs/internal/product-media-proof.json`

Required code work:

- Add strict schemas where missing.
- Add deterministic output.
- Add `--check` mode that fails on real redlines, not just drift.
- Decide whether outputs belong in `docs/internal/` permanently.
- Add generated markdown summaries for humans where useful.
- Wire `verify:control-files` into `verify:depth`.
- Wire relevant control-file checks into `release:verify`.

Done when: control files are part of the release gate and cannot silently drift.

### 3. Build The Missing Finish Systems

These are not optional if the goal is 100 percent code completion:

| missing system | code to add | purpose |
|---|---|---|
| Source boundary manifest | `scripts/build-source-boundary-manifest.cjs` and `verify:source-boundary` | Decide what is source, generated, local state, archive, fixture, scratch, report, release artifact, or forbidden. |
| Build graph and generator registry | `scripts/build-build-graph.cjs`, `docs/internal/build-graph.json`, `docs/internal/generator-registry.json`, and `verify:build-graph` | Own generator order, inputs, outputs, determinism, write permissions, and release inclusion. |
| Generated artifact manifest | `docs/internal/generated-artifact-manifest.json` and `verify:generated-artifacts` | Prove every generated output has a generator, owner, check command, and stale-file policy. |
| API contract matrix | `scripts/build-api-contract-matrix.cjs`, `docs/internal/api-contract-matrix.json`, `docs/internal/route-security-matrix.json`, `docs/internal/api-error-catalog.json`, `docs/internal/idempotency-matrix.json`, and `verify:api-contracts` | Own every route's auth, tenant scope, schemas, examples, errors, idempotency, audit, OpenAPI security, SDK/account/CLI ownership, and stub status. |
| Golden path matrix | `scripts/build-golden-paths.cjs`, `docs/internal/golden-paths.json`, and `verify:golden-paths` | Prove the three core product loops are complete across CLI, account, docs, API, evidence, and production states. |
| Account product matrix | `scripts/build-account-product-matrix.cjs` and `verify:account-product-matrix` | Own every post-auth page, state, API, journey, and auth smoke. |
| Account shell and interactions | `scripts/build-account-shell-contract.cjs`, `docs/internal/account-shell-contract.json`, `docs/internal/account-interaction-contract.json`, and `verify:account-shell` | Own account metadata, nav, skip links, focus, buttons, disclosures, inline-style retirement, and page-level state machines. |
| Page family contracts | `scripts/build-page-family-contracts.cjs` and `verify:page-family-contracts` | Own every first-screen, CTA, media, copy, SEO, and accessibility contract. |
| Claim copy map | `scripts/build-claim-copy-map.cjs` and `verify:claim-copy-map` | Bind public claims to shipped/local/external-gated evidence. |
| Production evidence packet | `scripts/build-production-evidence-packet.cjs` and `verify:production-evidence` | Prove live deploy, env, smoke, screenshots, rollback, telemetry. |
| Final build redline | `scripts/build-final-redline.cjs` and `verify:final-redline` | Aggregate all current blockers into one release decision. |

Done when: these systems exist, are deterministic, and are in the final verification path.

### 3A. Convert "Seed Docs" Into Code Or Archive Them

The seed documents are not deliverables. Each must either produce code or be archived.

| seed doc | required conversion |
|---|---|
| `docs/research/kolm-codebase-file-ledger-seed-2026-05-25.md` | Generated file ledger plus strict redline remediation. |
| `docs/research/kolm-design-cascade-ledger-seed-2026-05-25.md` | Generated design ledger plus CSS/component cleanup. |
| `docs/research/kolm-product-media-proof-seed-2026-05-25.md` | Generated media proof plus real media fixes in public pages. |
| `docs/research/kolm-product-feature-completion-matrix-seed-2026-05-25.md` | Generated feature matrix plus route/account/docs/CLI ownership fixes. |
| `docs/research/kolm-account-product-matrix-seed-2026-05-25.md` | Generated account matrix plus post-auth page state fixes. |

Done when: no seed doc is used as evidence of completion.

### 3B. Finish The Deterministic Build Graph

The codebase is not finished while generated files depend on memory, lucky ordering, or one-off script runs. The build itself must become product code.

Required code work:

- Add `scripts/build-build-graph.cjs`.
- Generate `docs/internal/build-graph.json` with every generator, verifier, mutator, report writer, package builder, docs builder, screenshot runner, archive writer, and release verifier.
- Generate `docs/internal/generator-registry.json` with one row per writing script.
- Generate `docs/internal/generated-artifact-manifest.json` with one row per generated output.
- Add `verify:build-graph` and make it fail if a writing script is not registered.
- Add `verify:generated-artifacts` and make it fail if a generated file is stale, ownerless, nondeterministic without an explicit exemption, or release-included without provenance.
- Replace the hand-written `GENERATED_BY` list in `scripts/build-codebase-file-ledger.cjs` with the generated artifact manifest.
- Replace the hand-written `verify:depth` shell chain with either a generated script or a manifest-driven runner that can explain what it ran, why, and what it skipped.

Each build-graph node must declare:

- `id`
- `script_path`
- `owner_surface`
- `inputs`
- `outputs`
- `output_class`: `source`, `generated_committed`, `generated_ignored_report`, `release_artifact`, `archive_evidence`, `scratch`, or `local_state`
- `depends_on`
- `env_vars`
- `network_policy`: `none`, `local_only`, `external_required`, or `external_optional`
- `write_mode`: `create`, `overwrite`, `append`, `delete`, `archive`, or `migration`
- `determinism_policy`
- `timestamp_policy`
- `secret_redaction_policy`
- `check_command`
- `build_command`
- `failure_behavior`
- `release_included`

Ordering requirements:

- `scripts/build-api-ref.cjs` must run before `scripts/build-openapi.cjs`.
- Public docs builders must run before sitemap, `llms.txt`, AI context, and screenshot audits.
- Account page builders must run before account matrix, page-family contracts, and account screenshots.
- Brand/package identity must run before docs, SDK, package release, and marketplace verification.
- Runtime matrices must run before claims, product graph, readiness closeout, and final redline aggregation.
- Screenshot/report generators must never mutate source pages.

Determinism requirements:

- Stable JSON key order for all generated JSON.
- Stable file ordering for every directory walk.
- Stable timestamps through `SOURCE_DATE_EPOCH` or explicit nondeterministic classification.
- No absolute local paths in committed outputs unless path redaction is explicitly documented.
- No secrets, API keys, customer data, prompts, PHI, PII, local env values, or tenant data in generated outputs.
- Every package/archive/Docker output must include source hash, lockfile hash, command, environment class, and artifact digest.

Done when: a new generated artifact cannot be added without a generator, owner, inputs, outputs, deterministic check, and release-inclusion decision.

### 3C. Retire One-Off Mutation Scripts Or Promote Them

The script directory contains many scripts that modify public files, docs, screenshots, reports, archives, and generated assets. That is acceptable only if each one has a permanent role.

Required code work:

- Classify every writing script as `generator`, `verifier`, `migration`, `report`, `archive`, `fixture_builder`, `package_builder`, or `delete_after_date`.
- Move expired migrations into an archive folder that is excluded from release source, or delete them after preserving useful lessons in the redline.
- Replace hardcoded page lists in one-off scripts with the page registry or product graph.
- Add `--check` and `--dry-run` to mutation scripts that remain.
- Require idempotence: running the script twice must not keep changing source.
- Require target manifests: every script must list the files it is allowed to write.
- Block scripts that mutate public/source files from running during screenshot audit or read-only verification.
- Make `release:verify` fail if a script can write to `public/`, `docs/internal/`, `reports/`, `archive/`, `packages/`, or `sdk/` without being in the build graph.

Migration scripts that likely need this treatment include:

- `scripts/add-twitter-card.cjs`
- `scripts/fix-forbidden-claims.cjs`
- `scripts/fix-nav-compare.cjs`
- `scripts/fix-theme-bootstrap.cjs`
- `scripts/inject-nav.cjs`
- `scripts/inject-nav-js.cjs`
- `scripts/inject-cookbook-jsonld.cjs`
- `scripts/brand-bars-swap.cjs`
- `scripts/brand-disambig-sweep.cjs`
- `scripts/clean-strip-artifacts.cjs`
- `scripts/ink-linen-scrub.cjs`
- `scripts/rewrite-nav-ks.cjs`
- `scripts/strip-dead-links.cjs`
- `scripts/strip-duplicate-footers.cjs`

Done when: there is no unknown script that can rewrite product code, public docs, generated artifacts, reports, archives, packages, or SDK files.

### 4. Finish Backend/API Code, Not Just Route Counts

Required work:

- Split or formally index `src/router.js`.
- Generate a route-owner map from router definitions, OpenAPI, and `docs/product-surfaces.json`.
- Enforce one envelope/error/auth/idempotency policy per route class.
- Remove hidden or duplicate route groups.
- Make route additions fail unless they include product-surface ownership and OpenAPI docs.
- Confirm account, cloud, storage, billing, provider, capture, distill, artifact, runtime, and governance routes all have concrete success/error examples.
- Keep local-only and external-gated capabilities scoped in responses and copy.

Done when: a new route cannot be merged without owner, docs, envelope, auth, errors, product surface, and smoke.

### 4A. Finish API Security And Tenant Semantics

The generated route inventory currently proves route presence, not route safety. Completion requires route-level security metadata.

Required work:

- Add route metadata fields for `auth_required`, `tenant_scope`, `object_authorization`, `function_authorization`, `rate_limit_class`, `resource_limit_class`, `idempotency`, `request_schema`, `response_schema`, `error_schema`, `ssrf_policy`, `upstream_trust_boundary`, `secret_policy`, and `audit_event`.
- Treat `/v1/account`, `/v1/team`, `/v1/teams`, `/v1/admin`, `/v1/billing`, `/v1/storage`, `/v1/cloud`, `/v1/capture`, `/v1/distill`, `/v1/runtime`, `/v1/marketplace`, and `/v1/agents` as P0 security route groups.
- Encode tenant and object authorization in the route inventory, not just in handler code.
- Add explicit rate/resource classes for routes that can call models, fetch upstream URLs, run compute, write storage, spawn local processes, or export data.
- Add safe SSRF handling for any endpoint that accepts a URL, provider base URL, webhook target, marketplace package, storage endpoint, or remote runtime address.
- Add audit events for every state-changing route, especially key rotation, billing, plan changes, storage purge, capture promotion, distill job creation, artifact publish/install, deploy, approval, and rollback.
- Ensure generated OpenAPI shows auth/security schemes and security notes instead of empty auth metadata.
- Add redaction guarantees for readiness and error responses that mention env var names, providers, tokens, storage, or cloud credentials.

Done when: no generated route entry has empty auth/security ownership, and every P0 route group carries tenant, rate, schema, audit, and SSRF/upstream policy metadata.

### 4A-2. Finish API Contract, Error, And Idempotency Semantics

The current route inventory and OpenAPI files are useful but not sufficient. A customer, SDK generator, account page, CLI command, and operator must be able to understand every route without reading `src/router.js`.

Required code work:

- Add `scripts/build-api-contract-matrix.cjs`.
- Generate `docs/internal/api-contract-matrix.json`.
- Generate `docs/internal/route-security-matrix.json`.
- Generate `docs/internal/api-error-catalog.json`.
- Generate `docs/internal/idempotency-matrix.json`.
- Add `verify:api-contracts`.
- Make `scripts/build-openapi.cjs` consume the API contract matrix, not just route path discovery.
- Make `scripts/build-api-ref.cjs` fail if a route lacks summary, owner, request schema, response schema, error schema, security metadata, state model, or claim scope.
- Replace direct route errors with a single canonical error helper that can emit Kolm's legacy `{ok:false,error}` shape and RFC 9457-compatible problem details.
- Make every error include stable code, HTTP status, retryability, surface, journey, request/correlation ID, safe user detail, account/docs next action, and redacted debug reference.
- Make every mutating route declare idempotency behavior: `required`, `accepted`, `not_applicable`, or `dangerous_no_retry`.
- Add idempotency storage or replay detection for create/promote/deploy/publish/delete/purge/rotate/upgrade routes where duplicate execution would harm users.
- Add request schema and response schema for every mutating route, even when the request body is intentionally empty.
- Add examples for success, validation failure, auth failure, object-authorization failure, rate/resource limit, missing external provider, and local-only/preview-gated state.
- Add route-level object authorization tests for path/query/body IDs that reference tenant-owned resources.
- Add OpenAPI `security` to every non-public operation and explicit `security: []` to public operations so consumers can distinguish public from accidental omissions.
- Add parser-compatibility checks for generated JSON with Node and PowerShell-compatible parsing or a documented canonical JSON toolchain.

Required route contract fields:

- `route_id`
- `method`
- `path`
- `owner_module`
- `product_surface`
- `journey`
- `account_pages`
- `cli_commands`
- `auth_required`
- `auth_methods`
- `tenant_scope`
- `object_authorization`
- `role_required`
- `plan_required`
- `rate_limit_class`
- `resource_limit_class`
- `idempotency_policy`
- `request_schema`
- `response_schema`
- `error_schema`
- `problem_types`
- `audit_event`
- `state_model`
- `claim_scope`
- `preview_or_stub_status`
- `openapi_operation_id`
- `examples`
- `production_smoke`

Done when: OpenAPI, API docs, SDKs, account pages, CLI help, and route smoke all derive from the same contract, and no mutating route can ship without schema, idempotency, audit, and object-authorization policy.

### 4B. Finish LLM-Specific Security Controls

Kolm is an AI product, so generic API security is not enough.

Required work:

- Threat-model prompt injection across capture, runner, agent, tool-use, assistant, docs demo, and `.kolm` runner flows.
- Validate and sandbox model outputs before using them as code, commands, URLs, tool calls, route parameters, SQL-like filters, file paths, or deployment instructions.
- Add poisoning controls for capture ingestion, active learning, synthetic data, distillation datasets, and marketplace artifacts.
- Add resource caps for context length, token budget, distill jobs, artifact builds, compute jobs, local runner process time, and batch APIs.
- Track model/provider/dataset supply chain: source, version, license, hash, eval provenance, risk notes, and revocation state.
- Prevent sensitive information disclosure through model outputs, traces, logs, readiness endpoints, demos, and account exports.
- Scope agent/plugin permissions with least privilege, explicit approvals, and durable audit records.
- Add model theft and artifact exfiltration controls for registry, marketplace, artifact download, signed export, and local device transfer.

Done when: every AI-bearing feature has prompt/data/output/tool/resource/supply-chain controls and those controls are visible in product/account readiness.

### 5. Finish CLI Code, Not Just Help Text

Required work:

- Split `cli/kolm.js` into command modules or generate a command ownership map that is strict enough to enforce boundaries.
- Move generated/bundled data reads into shared helpers.
- Make help, docs, command parser, and tests consume one command manifest.
- Remove stale or duplicate command aliases unless explicitly backwards-compatible.
- Add command groups for every product journey: capture, privacy lake, datasets, distill, compile, runtime, cloud, devices, governance, agents.
- Make every command that mutates state expose dry-run or explicit confirmation where needed.

Done when: CLI behavior is modular, documented from one source, and each command is owned by a product journey.

### 6. Finish Account Product Code

Required work:

- Build `docs/internal/account-product-matrix.json`.
- Map all 41 current account pages.
- Resolve the 22 pages missing product-graph ownership.
- Make `overview.html` the actual command center for all 12 journeys.
- Label pages as live dashboard, setup wizard, operator workbench, reference page, generated report, experimental wave, or archive.
- Ensure every live dashboard has API routes, loading, empty, error, partial, success, no-auth, no-credential, and no-data states.
- Add account auth smoke for local and production.
- Remove or archive account pages that are not real product surfaces.

Done when: every account page is owned, state-complete, and product-graph aligned.

### 6A. Close Account Page Gaps By Category

The quick scan found several account pages without direct literal `kfetch`/`fetch` calls. That does not automatically mean broken, but it means they cannot be accepted without classification.

Required account matrix categories:

| category | pages | required decision |
|---|---|---|
| Static or incomplete candidates | `ab-tests`, `active-learning`, `bakeoff`, `captures`, `confidence`, `continuous-monitoring`, `multimodal-bakeoff`, `pipelines`, `routing`, `sustainability` | Connect to live API, mark as generated/report/reference, or archive/redirect. |
| Auth ambiguity | `pipelines` | Add account auth shell, route through signed account layout, or move out of `/account`. |
| P0 operational dashboards | `overview`, `storage`, `billing`, `api-keys`, `artifacts`, `captured`, `datasets`, `distill-runs`, `lake`, `labeling`, `devices`, `audit-log` | Must have live API state, no-data state, missing-credential state, error state, and production auth smoke. |
| Advanced AI/product dashboards | `failure-modes`, `drift`, `drift-alert`, `staleness`, `synthetic`, `seasonal`, `simulations`, `bakeoffs`, `agent-telemetry` | Must state whether data is live, simulated, benchmark-scoped, or external-gated. |
| Enterprise/governance dashboards | `approvals`, `chargeback`, `sla`, `privacy-events`, `settings`, `connectors` | Must include tenant/RBAC/audit/export contracts and support no-SSO/no-SCIM states. |

Done when: the generated account matrix names page type, journey, API routes, state model, auth requirement, data provenance, and product status for all 41 pages.

### 6B. Finish The Account Shell And Interaction State System

The account product is not finished while each page carries its own shell fragments, inline styles, nav copy, metadata, and JavaScript state decisions. Post-auth UX must be a product shell with owned page modules.

Required account shell work:

- Generate account `<title>`, description, canonical URL, breadcrumb schema, and H1 from `docs/internal/account-product-matrix.json`.
- Replace all account bad `U+7E5A` title separators with the canonical ASCII separator.
- Keep exactly one skip-link system per page, first in the interactive order, pointing to the actual main landmark.
- Move account top nav, account sidebar, breadcrumbs, page header, loading skeleton, empty state, error state, and toolbar patterns into shared account shell components.
- Replace hardcoded account top nav links (`Wrapper`, `Studio`, old GitHub URL) with the same navigation manifest used by public pages.
- Remove inline `style=` from account pages except for explicitly safe dynamic sizing generated by a component.
- Replace page-local button, pill, metric, table, chart, modal, drawer, filter, and command styles with tokenized classes.
- Ensure each page has one `aria-current="page"` in account sidebar and one current item per breadcrumb/step set.
- Use disclosure buttons with `aria-expanded` and Enter/Space behavior for mobile nav, filters, sidebars, and detail panels.
- Add visible focus indicators that survive dark and light themes for every account link, button, input, select, table action, copy control, and drawer/disclosure control.
- Make every account button declare `data-command-id`, owning API/CLI equivalent, disabled/loading/error/success state, and confirmation requirements if mutating.
- Move account fetch/auth helpers out of `overview.html` into shared account runtime code with typed error envelopes.
- Surface no-auth, no-plan, no-team, missing-provider, missing-storage, local-only, cloud-ready, benchmark-gated, package-gated, certification-gated, and production-ready states consistently.

Required generated artifacts:

- `docs/internal/account-shell-contract.json`
- `docs/internal/account-interaction-contract.json`
- `docs/internal/account-state-machine.json`

Done when: a new account page cannot be added without shell metadata, nav state, API/CLI ownership, state machine, keyboard/focus behavior, and generated account proof.

### 7. Finish Frontend Code, Not Just Screenshots

Required work:

- Collapse nav into one canonical implementation.
- Remove or quarantine hidden test/proof payloads from public pages.
- Promote canonical tokens/components into `design-tokens.css`, `ks.css`, and `wf01-components.css`.
- Shrink or retire migration sheets such as `brand-refresh.css`, `surface-polish.css`, `home-refresh.css`, and wave CSS once rules are promoted.
- Replace page-local button, card, table, popover, and nav styles with canonical components.
- Fix product media as code: actual `<video>`, live demo, artifact preview, code comparison, or screenshot components with fallback/state.
- Keep page copy short and driven by product outcome, not internal jargon.

Done when: the design cascade ledger has no unowned component variants and page families use canonical components.

### 7A. Finish UI/UX As Code

The UI/UX target is not "looks better." It is a repeatable product-quality system across every product surface.

Required work:

- Create a page-family contract for homepage, product, pricing, enterprise, docs, API reference, quickstart, trust, benchmarks, account dashboards, account wizards, account reports, and account settings.
- For each page family, define one first-screen promise, one primary action, one proof asset, one fallback state, one SEO title pattern, and one accessibility target.
- Replace scattered page-local components with canonical nav, hero, proof widget, code comparison, ROI calculator, media frame, pricing card, plan selector, account status card, table, form, modal, popover, chart, and empty-state components.
- Remove hover-only navigation dependencies; every mega menu and popout must work with keyboard, pointer, touch, escape, and blur.
- Fix nav underline/highlight behavior as a component contract, not page-local CSS.
- Treat inline styles as migration debt unless they are dynamic widths controlled by a safe component helper.
- Reserve layout space for demos, video, generated screenshots, API tables, and account data to prevent layout jump.
- Add reduced-motion behavior to animated demos, hero motion, charts, and media transitions.
- Stop using hero-scale text inside dashboards, tables, cards, or account panels.
- Keep every interactive target at WCAG 2.2-friendly size and spacing.

Done when: a page-family verifier can prove the product UX uses canonical components and the design cascade ledger trends down instead of growing.

### 7B. Finish Copy As Product Architecture

Kolm has three product surfaces. Copy must serve all three:

1. Route and capture existing model traffic.
2. Distill and compile top-model behavior into signed artifacts.
3. Run and govern those artifacts across cloud, BYOC, edge, local, browser, and devices.

Required work:

- Replace vague hero/category language with a three-surface promise.
- Ensure every public page maps to one surface, one buyer/use case, one proof path, and one next action.
- Remove long paragraph clusters from first screens; move dense explanations into docs or expandable technical sections.
- Replace internal jargon with product outcomes unless the page is explicitly for expert docs.
- Keep external-gated claims scoped: benchmark, certification, package, and ecosystem claims must say what is local, public, or blocked.
- Make every CTA contract consistent: self-serve plans go to signup/account; Enterprise goes to sales/inquiry; docs go to runnable quickstart; product proof goes to demo/artifact.

Done when: the claim copy map can block stale plan names, overclaims, unsupported runtime promises, and hero copy that explains only one product surface.

### 7F. Finish Kolm Brand, Package, And Repository Identity

Final product identity must be boringly consistent. Users should see one product name, one CLI name, one package naming pattern, one GitHub identity, one docs install path per language, and one migration story for old names. "Kolmogorov" can exist only in explicitly archived historical material or in a temporary redirect/migration note that is excluded from public product surfaces.

Required work:

- Create `docs/internal/brand-package-identity.json`.
- Declare canonical values for product name, company/org name, CLI binary, root package, npm scope, TypeScript SDK package, Python SDK package, MCP package, React Native package, VS Code extension, GitHub repository URL, Docker image namespace, docs domain, support issue URL, and public schema publisher.
- Decide whether `github:sneaky-hippo/kolmogorov-stack` remains a supported temporary install path. If yes, label it as temporary compatibility and centralize it behind one generated constant. If no, rename/migrate and remove it from public docs.
- Replace public docs install commands using `@kolmogorov/sdk`, `@kolmogorov/mcp`, `@kolmogorov/cli`, `kolmogorov-recipe`, and `kolmogorov-stack` with canonical `@kolm/*`, `kolm`, or source-preview commands that actually match package metadata.
- If the GitHub repository is renamed, follow the GitHub-specific migration constraints: update actions because renamed action calls are not redirected, update local clone docs, update package repository fields, update CloudFormation/Docker/install scripts, update GitHub Pages/custom-domain assumptions, and reserve the old repo name so redirects remain stable.
- Add package publication state per package: `published`, `source_preview`, `private_internal`, `worker_optional`, `deprecated_alias`, or `not_shipped`.
- Generate all docs quickstart install commands, public SDK pages, package READMEs, API examples, account onboarding copy, and CLI help package references from that matrix.
- Expand the brand gate beyond backend-owned roots to include public docs, account pages, generated HTML/JSON/TXT, package metadata, CI actions, Docker/CloudFormation install paths, schema metadata, and SEO/discovery files.
- Keep historical/research files either excluded from the final release package or annotated as archive so old names do not count as public product truth.

Done when: a scan of release-relevant public/code/package surfaces has zero unapproved Kolmogorov tokens, zero stale `@kolmogorov/*` install commands, zero unpublished packages advertised as shipped, and every remaining old-name reference has an explicit migration owner and expiry date.

### 7C. Finish Performance And Production UX Telemetry

Required work:

- Add field measurement for LCP, INP, and CLS by page family.
- Send Core Web Vitals to a backend route or telemetry endpoint with route, theme, viewport class, auth state, and build hash.
- Define per-family budgets for JS, CSS, image/video bytes, blocking scripts, and long tasks.
- Split heavy public docs/API/reference payloads so homepage and pricing do not pay for them.
- Add production alerting for Core Web Vitals regressions on homepage, pricing, docs, and account overview.
- Keep lab screenshot audits, but treat them as pre-deploy checks only.

Done when: production RUM proves the deployed UX is fast and stable for real users, not just locally visible.

### 7D. Finish Navigation And Information Architecture

Navigation is product architecture. It must help a technical buyer understand the three product surfaces, reach value quickly, and operate the account after auth.

Required work:

- Create a generated navigation contract that owns top nav, mega menu, mobile nav, footer, docs nav, account nav, breadcrumbs, and page-family sidebars.
- Collapse product navigation around the three product surfaces: route/capture, distill/compile, run/govern.
- Keep use-case pages grouped by buyer outcome, not by internal wave or implementation history.
- Remove duplicate or ambiguous account entrypoints; every `/account/*` link must map to one product journey and one state model.
- Ensure `public/nav.js` consumes a product/navigation manifest instead of hand-maintained page lists.
- Add keyboard/touch parity for mega menus, including focus trap avoidance, escape behavior, blur close, and active underline consistency.
- Add canonical breadcrumbs and section labels for docs, API reference, account, use cases, security/trust, and research.
- Make archived/reference pages visually and structurally distinct from live product surfaces.

Done when: nav can be generated from the same product graph/account matrix/page-family contracts that drive docs and account UI.

### 7E. Finish SEO, AI Discovery, And Metadata

The current quick scan found many title separator and snippet issues. This is code debt because metadata should be generated from page-family contracts, not hand patched.

Required work:

- Generate titles, descriptions, canonical URLs, OpenGraph, Twitter cards, schema, `llms.txt`, `.well-known/ai-context.json`, and sitemap entries from a single page registry.
- Replace the old non-ASCII separator pattern in all generated titles and schema with a canonical ASCII separator.
- Cap descriptions by page family and make them outcome-led.
- Add an H1 to `public/defense.html`, `public/enterprise.html`, `public/finance.html`, `public/health-insurance.html`, `public/healthcare.html`, `public/index.html`, `public/legal.html`, and `public/quickstart.html`.
- Add `<main>` and skip-link coverage to `public/account/pipelines/index.html`, `public/account/pipelines/_template.html`, `public/security/membership-inference.html`, and `public/design-system.html`.
- Ensure every page has one canonical page type: product, docs, account, trust, research, use case, compare, pricing, legal, or archive.
- Ensure `sitemap.xml`, `robots.txt`, `llms.txt`, and AI context files are generated from the same registry and include only intended public pages.

Done when: metadata generation prevents stale titles, long snippets, missing H1s, duplicate canonicals, and public discovery drift.

### 8. Finish Product Media And Demo Code

Required work:

- Wire or retire `public/video/kolm-hero.mp4`, `kolm-hero.webm`, and poster.
- Add a real homepage proof component: live `.kolm` runner, code swap, artifact preview, or current video.
- Add product proof media to `/product`, `/pricing`, `/enterprise`, `/docs`, and `/account/overview`.
- Generate or delete missing OG/social assets.
- Classify generated raw images as canonical, archive, or delete.
- Add transcripts, captions, dimensions, fallbacks, and reduced-motion behavior.

Done when: product-media proof has no missing primary media for key pages and no unowned large media assets.

### 9. Finish Docs And SDK Code Paths

Required work:

- Generate API docs only from current route inventory.
- Generate CLI docs from the command manifest.
- Generate SDK docs/examples from supported SDK manifests.
- Remove stale manual pages that conflict with generated route/CLI/API truth.
- Make quickstarts runnable and tied to real expected outputs.
- Keep package-release status explicit until packages are actually published.

Done when: docs are generated or checked from source-of-truth manifests and cannot publish stale commands, routes, SDKs, or pricing.

### 9A. Finish Developer Experience As Product

Developer experience is a product surface, not a docs afterthought.

Required work:

- Make the first 10-minute path real for each surface: route/capture, distill/compile, run/govern.
- Add copy-paste runnable examples for OpenAI-compatible routing, artifact compilation, local run, cloud readiness, storage readiness, and account auth.
- Attach expected outputs and failure messages to every quickstart.
- Add SDK parity matrices for Node, Python, MCP, VS Code, C, Rust, TypeScript package, Swift, Kotlin, and React Native with actual install/build status.
- Split package-manager release docs from local-source-only docs so unavailable package channels are not implied shipped.
- Add troubleshooting pages for provider credentials, storage readiness, local GPU, package install, account auth, route 401/403, and artifact verification.
- Ensure docs pages never expose stale plan names, stale route counts, hidden test anchors, or generated mojibake.

Done when: a developer can start from docs and finish a real product workflow without guessing which pages are aspirational.

### 10. Finish Data, Security, And Release Hygiene

Required work:

- Ensure local data under `data/` is ignored, classified, and secret-scanned.
- Remove local backups and temp files from the release tree.
- Confirm `.vercelignore`, package `files`, and deployment includes/excludes are correct.
- Ensure no control files or research specs leak to the public site unless intentionally linked.
- Confirm all env-driven cloud/storage/GPU/SSO states are displayed as missing/configured without secrets.
- Keep compliance/certification claims gated until external proof exists.

Done when: release packaging includes only intentional code, assets, docs, generated artifacts, and public files.

### 10A. Finish Secure Release Engineering

Required work:

- Generate a dependency/source inventory with package versions, package-lock hash, runtime version, scripts used, and build artifact hashes.
- Ensure `npm audit` or equivalent vulnerability intake is recorded in the production evidence packet, with exceptions explicitly approved.
- Add secret scanning for source, docs, public files, generated artifacts, reports, `.env*`, and local data.
- Add provenance for generated docs, OpenAPI, product graph, control files, SDK bundles, and media assets.
- Make release verification fail if generated artifacts are stale, untracked, or built from a different commit.
- Record SLSA-style provenance fields: source revision, builder, build command, dependencies, artifact digests, and verification summary.
- Ensure every provider credential path reports configured/missing without secret values and never writes live secrets into reports.
- Verify `.vercelignore`, npm package `files`, Docker/deploy includes, and public static assets do not leak internal docs or scratch outputs.

Done when: final release evidence can answer exactly what source produced each shipped artifact and prove no secret/scratch/internal file leaked.

### 10B. Finish CI/CD Hardening

The workflows are part of the product. They compile artifacts, run proofs, publish packages, and may handle secrets.

Required work:

- Add explicit least-privilege `permissions` to every workflow and job.
- Add `concurrency` groups to prevent overlapping release, deploy, publish, and smoke jobs.
- Pin third-party actions by SHA or document a strict version-pinning policy with an update process.
- Add OIDC/trusted publishing for package publication instead of long-lived npm tokens.
- Ensure workflows that run on pull requests cannot access production secrets or deploy credentials.
- Move untrusted values from shell interpolation into environment variables or arguments with quoting.
- Add workflow-level secret inventory: which job can see which secret, why, and whether it can write to repo, package registry, cloud, or deployment target.
- Add artifact retention rules and avoid uploading secrets, `.env`, screenshots with customer data, or internal reports.
- Require CI to produce a release packet that includes workflow run id, commit, runner image, Node/npm versions, package-lock hash, generated artifact hashes, and pass/fail summary.

Done when: a compromised low-trust workflow cannot publish, deploy, exfiltrate secrets, or mutate protected release artifacts.

### 10C. Finish SDK And Package Release Readiness

The codebase contains multiple package channels. They are not finished until each channel has build, test, docs, packaging, provenance, and install proof.

Required work:

- Create `docs/internal/sdk-release-matrix.json` covering every package under `packages/` and `sdk/`.
- For each package, record package name, version, runtime, license, build script, test script, type declarations, files allowlist, readme, examples, package size, publish status, provenance status, and install smoke command.
- Add missing build/test scripts or mark packages as source-only/internal.
- Add `publishConfig` only when publication target and access policy are intentional.
- Add provenance or trusted publishing for npm packages.
- Add package dry-run checks for Node, TypeScript, React Native, MCP, VS Code, attestation, LangChain, LlamaIndex, C, Rust, Swift, Kotlin, and any generated SDK.
- Remove build outputs like `sdk/rust/target` from source-controlled/release source unless explicitly produced as release artifacts.
- Split "SDK source exists" from "package is published" in docs and public copy.

Done when: every SDK/package has a truthful release state and no package channel is implied shipped without installable proof.

### 10D. Finish Deployment Topology And Environment Boundaries

Deployment must be reproducible and auditable across Vercel, Railway, Docker, workers, services, and local dev.

Required work:

- Create `docs/internal/deploy-topology.json` mapping Vercel routes/functions, Railway service, Docker image, workers, services, storage, provider credentials, and public static assets.
- Make `vercel.json`, `.vercelignore`, `railway.toml`, Dockerfile, and package scripts agree on the same runtime, route set, and included files.
- Add a deployment include/exclude verifier that catches `docs/internal`, `docs/research`, `.env*`, `tmp`, `reports`, build targets, local data, and scratch output leakage.
- Add environment schema with required, optional, local-only, production-only, secret, non-secret, and deprecated variables.
- Add production env readiness checks that show configured/missing status without printing secret values.
- Ensure `.env`, `.env.cloudflare`, `.env.local`, and tmp launch env files are ignored or quarantined and never included in deployment or reports.
- Add deploy rollback contract: previous deployment id, data migration compatibility, route compatibility, artifact compatibility, and smoke path.

Done when: deploy evidence proves the exact files and env classes shipped, and no local secret/build/scratch artifact can leak.

### 10E. Finish Data Inventory, Retention, And Privacy Rights

The product captures model traffic, traces, prompts, outputs, artifacts, labels, evals, billing events, teams, audit rows, and deployment state. This is core product data, not incidental storage.

Required work:

- Create `docs/internal/data-inventory.json` covering every file/table/object/event stream in `data/`, SQLite, object storage, account APIs, capture lake, artifacts, workers, reports, and generated outputs.
- Classify each data store as fixture, local dev state, production state, generated artifact, scratch, backup, telemetry, customer data, secret-bearing, regulated data, or public asset.
- Add retention, deletion, export, backup, restore, encryption, residency, tenant scope, audit event, and product owner for every data class.
- Replace ad hoc `.bak` and `.tmp` persistence with an intentional backup/rotation policy or exclude it from release worktrees.
- Ensure `observations.json`, backups, SQLite WAL/SHM files, and local artifact outputs are never shipped or committed unless explicitly fixture-scrubbed.
- Add privacy-right workflows for access/export, deletion, portability, retention override, legal hold, audit export, and tenant offboarding.
- Add account UI states for data export running/completed/failed, deletion requested/processing/completed/blocked by legal hold, retention configured/default/missing, and storage unavailable.
- Add automated redaction/secret scans for data exports, reports, screenshots, logs, artifacts, and generated docs.

Done when: every data store and export path has an owner, purpose, retention rule, tenant boundary, release classification, and user-visible lifecycle state.

### 10F. Finish Tenant, RBAC, And Customer Lifecycle State Machines

The account product cannot be complete without exact state machines for users, teams, tenants, plans, keys, approvals, exports, and deletion.

Required work:

- Create `docs/internal/tenant-rbac-matrix.json` mapping users, tenants, teams, roles, API keys, service keys, SSO users, SCIM users, invites, approvals, and audit events.
- Define authorization checks for object access, function access, admin actions, billing actions, storage actions, artifact publish/install, capture promotion, distill jobs, deploy/rollback, and data exports.
- Add role/state UI for owner/admin/member/viewer/billing/security/auditor/developer/operator where applicable.
- Add lifecycle states for signup, email verification, key creation, provider connection, plan selection, trial/free/pro/team/enterprise, suspended, canceled, deleted, enterprise sales pending, SSO enabled, SCIM pending, and offboarded.
- Add idempotency and confirmation contracts for mutating routes including account delete, key rotation, storage purge, approval decisions, plan changes, deploy, rollback, artifact publish, and export.
- Add audit-event completeness: who, tenant, object, action, before/after, reason, request id, source, timestamp, result, and retention class.
- Add account UX for permission denied, missing role, pending approval, expired invite, suspended billing, missing SSO, no SCIM, deleted tenant, and external-gated feature.

Done when: every mutating route and account operation has a tenant/RBAC decision, audit event, idempotency policy, and visible customer lifecycle state.

### 10G. Finish Billing, Revenue, And Enterprise Lifecycle

Pricing and billing are product code. They must not drift from plans, Stripe/payment state, usage, savings, sales routing, and account state.

Required work:

- Create `docs/internal/billing-lifecycle-matrix.json` tying plan definitions, pricing page, `/v1/plans`, `/v1/billing/tiers`, Stripe/payment routes, account billing UI, CLI billing copy, sales inquiry, and enterprise custom plan rules.
- Define plan states: free, pro, team, enterprise custom, trial, past_due, canceled, suspended, sales_required, payment_failed, invoice_pending, and legacy-mapped.
- Ensure Enterprise never routes to fake self-serve checkout and always preserves contact-sales flow unless a real enterprise checkout exists.
- Add usage/savings truth: current spend source, estimated savings assumptions, provider/model pricing date, confidence interval, and what is excluded.
- Define invoice/payment data boundaries so card data stays in Stripe or the chosen processor and Kolm does not accidentally enter broader PCI scope.
- Add account UI states for no payment method, payment failed, upgrade pending, downgrade scheduled, sales review, invoice available, usage unavailable, and plan legacy migration.
- Add audit events for plan change, key rotation, payment state change, sales inquiry, Enterprise approval, cancellation, and deletion.

Done when: pricing, billing APIs, account billing, plan CTAs, usage, savings, emails, CLI, docs, and sales flows all derive from one billing lifecycle matrix.

### 10H. Finish The Monorepo Source Boundary

The repo is not only the root Node app. It is a multi-runtime product tree with browser pages, Node APIs, Python trainer/runtime apps, Workers, SDKs, CI actions, deploy config, local data, archives, and generated reports. A finished build must know exactly which paths are source, generated output, local state, archive, release artifact, fixture, or scratch.

Required work:

- Add a source-boundary manifest that classifies every top-level directory and every generated-output family.
- Treat `apps/`, `workers/`, `services/`, `sdk/`, `packages/`, `public/`, `scripts/`, `.github/`, `infra/`, `api/`, `tools/`, `examples/`, `tests/`, and `test/` as first-class code surfaces, not background folders.
- Remove or ignore Python `__pycache__`, `*.pyc`, Rust/SDK build targets, temp files, old logs, local screenshots, local data backups, archive snapshots, malformed scratch paths, and report outputs unless they are intentionally published artifacts.
- Make `.gitignore`, `.vercelignore`, package files, Docker context, Railway/Vercel config, and release package generation consume the same source-boundary manifest.
- For every generated artifact, record generator, input files, output path, determinism contract, owner, and whether the artifact is committed, ignored, or uploaded as release evidence.
- For every archive snapshot, decide whether it is retained as historical evidence, moved out of the release source tree, or deleted.

Done when: one manifest can explain why every file is present and whether it can ship. A clean final build cannot contain unexplained cache, temp, backup, local data, or stale archive paths.

### 10I. Finish Python, Worker, And Service Runtime Code

The compile/distill/runtime story depends heavily on Python apps and isolated Workers. Root JS tests do not prove those surfaces work.

Required work:

- Give every Python app a declared entrypoint, dependency set, lint/type policy, smoke command, artifact contract, environment contract, and failure schema.
- Give every Worker a uniform `doctor`, `run`, `smoke`, `package`, `container`, `health`, and `telemetry` contract or explicitly mark it as labs/reference code.
- For `workers/distill`, replace "stub" mode with an explicitly named fixture mode and ensure no production route can treat fixture output as trained output.
- For `workers/quantize`, record method-level readiness, calibration requirements, target runtime compatibility, accuracy deltas, and model/license constraints.
- For `workers/compile-server`, finish the Docker/Helm/Kubernetes contract: non-root image, health/readiness probes, resource limits, secret mounts, trace/log wiring, artifact storage wiring, and rollback.
- For `apps/trainer`, `apps/runtime`, `apps/export`, and `apps/import`, make generated artifacts carry provenance, dependency versions, hardware/runtime assumptions, and error states.
- For `services/mcp`, decide if it is production-supported. If yes, add auth, rate limits, audit, tenant scoping, tool allowlist, and prompt/data boundary controls. If no, mark as local/labs only and keep it out of production claims.
- Ensure all Python and Worker environments are reproducible without polluting the root install: pinned lock or constraints, CPU fallback where possible, GPU readiness where required, and clear missing-toolchain output.

Done when: a developer can install each supported runtime surface, run its doctor, execute one real smoke, receive a product artifact or explicit blocked state, and see the same status in account/API/CLI/docs.

### 11. Finish Product Features End-To-End

Every product journey must work end-to-end:

| journey | finished means |
|---|---|
| route/capture | user can connect provider, route a call, capture it, view it, and see an artifact opportunity |
| privacy/lake | user can inspect storage, redaction, retention, privacy events, and exports |
| datasets/labeling | user can create candidates, label, split, simulate, and send to distill |
| train/distill | user can pick strategy, run or plan distill, see K-Score/failures, and produce artifact |
| compile/verify | user can compile, verify, diff, sign, export, and understand failures |
| runtime/inference | user can run/serve artifact and see latency/cost/quality/runtime target |
| cloud/compute | user can see provider readiness, storage readiness, compute target, and deploy path |
| devices/fleet | user can detect devices, install artifact, and verify device fit |
| enterprise/governance | user can manage keys, audit, billing, approvals, SSO/SCIM scope, compliance evidence |
| agents/registry | user can compile/serve/publish/install agent artifacts with telemetry and rollback |

Done when: each journey has API, CLI, account UI, docs, and production proof or an explicit non-shipped gate.

### 11A. Finish AI Evaluation, Risk, And Governance

Kolm's differentiator depends on credible evaluation and artifact evidence, not generic AI infrastructure claims.

Required work:

- Map K-Score, benchmark evidence, calibration, redaction benchmark, quality judge calibration, drift, staleness, A/B testing, and failure modes to a single evaluation evidence model.
- For each distill/compile artifact, record teacher, student, dataset, eval provenance, calibration version, benchmark scope, failure modes, risk notes, and artifact signature.
- Add AI risk classification fields: intended purpose, deployment context, human oversight, prohibited/high-risk/GPAI relevance, data governance, transparency notices, and incident reporting path.
- Make account governance pages show local evidence, missing external proof, and next actions without implying certification.
- Add red-team and poisoning evidence to capture, dataset, active learning, distill, marketplace, and agent surfaces.
- Require every public benchmark or savings claim to include dataset/date/model/provider/hardware/cost assumptions.
- Add post-deploy monitoring for quality drift, cost regression, latency regression, safety events, poisoning signals, and data retention failures.

Done when: every claim about quality, cost, safety, compliance, portability, or reproducibility is backed by artifact-level evidence and visible risk scope.

### 11B. Finish Distillation And Compilation As Real Product Capability

The distill/compile surface is not complete until it produces artifacts that a user can trust, operate, compare, and improve.

Required work:

- Create `docs/internal/ai-capability-matrix.json` mapping capture, dataset, distill, compile, quantize, verify, run, device install, benchmark, and governance features to code, routes, account pages, CLI, docs, and proof.
- Create `docs/internal/distillation-method-matrix.json` for every distillation mode: from-captures, on-policy, preference, reasoning-trace, contrastive, multi-teacher, curriculum, active learning, cross-namespace, multimodal, audio, video, cross-lingual, federated, and continuous background distill.
- For each distillation mode, require teacher source, student target, dataset source, data rights, poisoning controls, holdout strategy, K-Score, quality calibration, failure modes, cost model, artifact output, rollback path, and account UI state.
- Make synthetic, heuristic, stub, mock, placeholder, and local-only evidence explicit in API responses, account UI, docs, and public copy.
- Ensure compile jobs produce signed `.kolm` artifacts with manifest, provenance, evals, runtime targets, model card, dependency graph, and verification receipt.
- Add capability gates so an artifact cannot be marked production-ready with placeholder evals, missing model weights, missing holdout, unknown license, unsupported target runtime, or missing signature.
- Add failure-mode UX for insufficient captures, unsupported teacher, missing provider credentials, no holdout set, eval below gate, quantization accuracy drop, compile failure, artifact too large, runtime mismatch, and external package/certification gates.

Done when: a user can go from capture to distilled/compiled artifact with transparent evidence, and every scoped limitation is visible before they trust or deploy the artifact.

### 11C. Finish Runtime, Device, Quantization, And Model Catalog Claims

The "run anywhere" and "enterprise models down to any device" claims require hard runtime/device evidence.

Required work:

- Create `docs/internal/runtime-device-matrix.json` mapping runtime, device, hardware, model family, artifact size, quantization profile, context length, latency, memory, energy, accuracy delta, supported operations, install method, and rollback path.
- Promote the generated catalog into a canonical model/provider/runtime/device source used by website, account, CLI, docs, API, and deploy readiness.
- For each provider and model, record source URL/date, model id, modality, context length, tool/JSON support, pricing basis, data-use terms, capture legality, distillation legality, region availability, and deprecation state.
- For each local model, record architecture, parameter count, license, weights source, checksum, quantization variants, supported runtimes, supported devices, and model-card metadata.
- For each runtime, record supported artifact subset, ONNX/GGUF/safetensors/native support, CPU/GPU/NPU support, KV-cache strategy, batching/speculative decoding support, sandboxing, observability, and install status.
- For each device, record CPU/GPU/NPU/accelerator, memory, OS, browser support, power budget, supported quantization, local storage, secure enclave/key handling, and minimum viable artifact class.
- Require quantization profiles to include calibration data, task type, target runtime, target device, bit width, per-channel/per-token strategy, accuracy delta, latency delta, memory delta, and fallback policy.
- Add account UX for "fits device", "needs smaller quant", "unsupported runtime", "missing package", "benchmark absent", "accuracy degraded", and "external runtime adoption not yet shipped".

Done when: the catalog can prove which model/artifact can run on which runtime/device under which quality/performance tradeoff.

### 11D. Finish Benchmark, K-Score, And Public Proof Claims

Benchmark and K-Score are strategic product surfaces. They cannot remain partly local or synthetic if public copy treats them as market proof.

Required work:

- Create `docs/internal/benchmark-evidence-matrix.json` covering KolmBench, K-Score calibration, quality calibration, redaction benchmark, provider matrix, latency/cost/quality, raw outputs, hardware profiles, and public leaderboard rows.
- Keep fixture/local/synthetic benchmarks separate from public reproducible benchmark data.
- Require every public benchmark row to include dataset, version/date, prompt set, raw outputs, model/provider versions, hardware, runtime, quantization, latency, throughput, cost, quality metric, safety metric, and reproducibility command.
- Add benchmark freshness and retest cadence.
- Add confidence intervals or statistical notes for K-Score, quality judge, and A/B comparisons.
- Add account UI for benchmark missing, stale, partial, failed, below gate, externally verified, and public-ready states.
- Ensure public pages never imply K-Score is an accepted external standard until calibration data and external adoption exist.

Done when: public quality, cost, speed, compression, and safety claims are backed by reproducible, dated, raw benchmark evidence.

### 12. Finish Production Release Proof

Required work:

- Build production evidence packet.
- Deploy exact commit.
- Record deploy ID, URL, environment, build hash, generated artifact hashes, and rollback target.
- Run public smoke.
- Run authenticated account smoke.
- Run route-surface smoke.
- Run screenshots dark/light desktop/mobile.
- Verify product media renders.
- Verify account matrix renders.
- Verify no secrets in readiness outputs.
- Watch telemetry after deploy.

Done when: production evidence proves the live site matches the verified code and no open P0/P1 redline remains.

### 12A. Finish Observability And Runtime Operations

Local tests cannot replace production observability.

Required work:

- Adopt OpenTelemetry-compatible GenAI fields for provider, model, operation, request/response metadata, token counts, cost, latency, error, route, artifact id, tenant id hash, and eval context.
- Add product events for capture created, artifact opportunity, distill planned, distill completed, compile verified, artifact run, storage readiness, provider missing credential, deploy, rollback, approval, and export.
- Add front-end RUM for LCP, INP, CLS, route, theme, viewport class, and build hash.
- Add backend SLOs for route success rate, p95 latency, model/provider error rate, artifact compile time, distill queue latency, storage error rate, and account page data load failures.
- Ensure account dashboards expose operational state without leaking tenant data or secrets.
- Add production runbooks for outage, provider outage, storage degradation, high-cost spike, distill quality regression, artifact rollback, and account auth failure.
- Add telemetry sampling and redaction policy so prompts, responses, secrets, PHI, PII, and proprietary artifacts do not leak into logs.

Done when: production evidence can show what broke, which users/features were affected, whether data stayed safe, and how rollback works.

## Atomic File Redlines

These are the immediate codebase redlines. The action column is the work. The proof column is only how to verify afterward.

| path | redline | required code action | proof after action |
|---|---|---|---|
| `src/router.js` | 953 KB route monolith | Split by route family or generate strict route module ownership; make route registration reject missing owner/auth/envelope/OpenAPI metadata. | Route inventory has zero unowned routes and new route additions fail without metadata. |
| `cli/kolm.js` | 2 MB CLI monolith | Split commands into modules or generate a strict command manifest consumed by help, docs, parser, and tests. | CLI docs/help come from one manifest and no command is ownerless. |
| `scripts/build-account-pages.cjs` | Header says 15 account pages while current account surface is larger | Update generator ownership or split account page generation; make generated count match actual post-auth pages. | Account matrix reports every account page with journey, states, APIs, and auth smoke. |
| `public/account/overview.html` | Account command center is hand-integrated and not yet the full matrix source | Bind overview modules to generated product/account matrix and readiness contracts. | Overview shows all journeys with loading/empty/error/success/partial states. |
| `public/account/*.html` | Account scan found `41` pages, `15` mojibake titles, `34` duplicate skip-link systems, `41` pages with inline styles, `39` hardcoded old GitHub links/top-nav drift, `10` pages without literal `kfetch(`, and `102` buttons | Generate an account shell contract and retire per-page shell fragments, inline styles, stale nav, duplicate skip links, and unknown button commands. | `verify:account-shell` reports zero shell drift and every button/control has owner, state, and keyboard/focus behavior. |
| `scripts/build-account-shell-contract.cjs` | Missing | Generate account shell metadata, nav order, skip-link count, current-page state, inline-style inventory, command/button ownership, and state-machine requirements. | Account shell cannot drift from product graph, nav manifest, and design tokens. |
| `docs/internal/account-shell-contract.json` | Missing | Record one row per account page with title, H1, shell version, nav version, breadcrumbs, skip link, sidebar current item, and metadata source. | Account metadata and shell can be verified without reading page source by hand. |
| `docs/internal/account-interaction-contract.json` | Missing | Record account buttons, forms, filters, table actions, copy controls, disclosure controls, and their API/CLI/state ownership. | Buttons cannot exist as decorative or ownerless controls. |
| `docs/internal/account-state-machine.json` | Missing | Record no-auth, loading, empty, error, partial, missing credential, local-only, external-gated, success, disabled, and production-ready states for every live account page. | Account screenshots and API smoke prove state coverage, not just happy-path rendering. |
| `public/index.html` | Large homepage file with high risk of hidden legacy/test payload | Extract reusable product proof components; remove hidden proof/test payloads from the public UX. | Homepage source has no stale hidden anchors or dead demo/media code. |
| `public/pricing.html` | Pricing must never drift from billing source | Generate or validate pricing cards and CTAs from the billing tier source. | Pricing, `/v1/plans`, CLI billing, and docs report the same plan contracts. |
| `docs/internal/codebase-file-ledger.json` | Generated but untracked/internal status unclear | Decide tracked artifact vs ignored build output; if tracked, keep deterministic and current. | `verify:file-ledger` enforces zero scratch release paths. |
| `docs/internal/design-cascade-ledger.json` | Design control exists but cleanup is incomplete | Use ledger output to promote component styles and delete one-off page-local variants. | Design cascade has no unowned critical components. |
| `docs/internal/product-media-proof.json` | Media proof exists but usefulness is not enough | Ensure key pages use real product proof media, not decorative placeholders. | Product media proof maps each key page to real demo/video/screenshot/component evidence. |
| `docs/internal/wave-registry.json` | Generated but not final release authority | Make active lane locks and duplicate/superseded waves enforceable. | Concurrent wave edits cannot silently collide. |
| `docs/internal/catalog-manifest.json` | Catalog truth exists but must own public claims | Bind provider/model/runtime/device/pricing copy and UI to the manifest. | Public copy cannot advertise stale catalog facts. |
| `docs/internal/build-graph.json` | Missing | Generate the complete build DAG for generators, verifiers, mutators, reports, screenshots, packages, docs, archives, and release checks. | `verify:build-graph` fails when a writing script is unregistered or order is ambiguous. |
| `docs/internal/generator-registry.json` | Missing | Record every script that can write, delete, archive, package, or mutate files with owner, target manifest, mode, and idempotence policy. | No script can write to release-relevant paths without registry ownership. |
| `docs/internal/generated-artifact-manifest.json` | Missing | Record every generated output with generator, inputs, output class, deterministic check, release inclusion, and stale policy. | File ledger derives `generated_by` from this manifest, not from a partial hardcoded list. |
| `docs/internal/report-retention-manifest.json` | Missing | Classify screenshot, UI audit, prod smoke, benchmark, archive, and local report outputs by freshness, owner, and release value. | Old reports cannot be cited as current proof after expiry. |
| `scripts/build-build-graph.cjs` | Missing | Implement the build graph generator and check mode; consume package scripts and script write manifests. | The repo can explain and reproduce the build order from one machine-readable graph. |
| `scripts/build-codebase-file-ledger.cjs` | Hand-maintained `GENERATED_BY` list covers only part of generated output reality | Replace `GENERATED_BY` with `docs/internal/generated-artifact-manifest.json` and fail on unknown generated files. | Generated file ownership is complete and automatically checked. |
| `scripts/build-api-ref.cjs` and `scripts/build-openapi.cjs` | Known race class when run concurrently | Encode dependency order in build graph and make OpenAPI builder fail if route docs are mid-write or stale. | API docs and OpenAPI regenerate serially and reproducibly. |
| `scripts/build-docs-w374.cjs` | Wave-named docs generator still appears as active build code | Rename/split into a durable docs generator or archive it as a completed migration. | Docs generation names its product role instead of an old wave. |
| `scripts/add-twitter-card.cjs`, `scripts/inject-*.cjs`, `scripts/fix-*.cjs`, `scripts/brand-*.cjs` | One-off public/document mutation scripts can keep rewriting product files | Promote durable behavior to generators, add `--check`/`--dry-run`, or archive/delete expired migrations. | No one-off mutator remains in the release path without an owner and target manifest. |
| `scripts/build-final-redline.cjs` | Missing | Implement final aggregator for worktree, generated artifacts, route ownership, account matrix, design, media, claims, production evidence. | `reports/build-redline/final-build-redline.json` exists and blocks release until zero blockers. |
| `scripts/build-production-evidence-packet.cjs` | Missing | Implement production deploy evidence capture for commit, env, routes, auth, screenshots, rollback, telemetry. | Deploy can be accepted or rejected from one production packet. |
| `.w850-shots/` | Scratch screenshot output in repo tree | Move to ignored report location or delete after extracting useful evidence. | File ledger reports zero scratch paths. |
| `C?*site-failures*.txt` | Malformed scratch failure paths in repo tree | Move/delete/quarantine after preserving useful failure details. | File ledger reports zero malformed scratch paths. |
| `data/*.tmp` | Local observation backups in repo tree | Delete or quarantine outside release tree; ensure data ignore rules are correct. | Release package contains no local temp observation data. |
| `public/brand-refresh.css` | 169 KB migration stylesheet | Promote durable tokens/components into canonical CSS and delete expired migration rules. | Design ledger shows fewer raw hex, `!important`, radius, shadow, and duplicate component rules. |
| `public/surface-polish.css` | 126 KB polish stylesheet | Collapse one-off visual fixes into canonical components or page-family contracts. | No page depends on emergency polish selectors for core layout. |
| `public/warm-paper.css` | 83 KB theme layer | Decide if this is canonical brand direction or remove from surfaces that should feel enterprise/SaaS. | Theme use is explicit by page family and does not create one-note palette drift. |
| `public/styles.css` | 76 KB base stylesheet | Audit whether it is still base truth or legacy overlap with `ks.css` and `design-tokens.css`. | One base layer owns resets, layout primitives, and global typography. |
| `public/frontier.css` | 55 KB specialized stylesheet | Scope to frontier/research pages or promote shared pieces. | No unrelated product pages depend on frontier-specific styling. |
| `public/home-refresh.css` | 48 KB homepage migration stylesheet | Replace with stable homepage component CSS or remove after hero/product proof rebuild. | Homepage visual system is canonical and not wave/migration coded. |
| `public/docs/api.html` | 551 KB generated API page | Confirm it is generated from current routes and does not ship stale route/copy/state. | API docs regenerate cleanly and match OpenAPI route inventory. |
| `public/dashboard.html` | 121 KB legacy dashboard candidate | Classify as live product surface, redirect, archive, or account page replacement. | Page-family contract names its purpose and route. |
| `public/docs/api-routes.json` | 582 generated route entries with empty auth shape in quick parse | Add or expose auth/security metadata per route and route group. | API inventory proves auth, tenant, rate, schema, and surface ownership. |
| `public/openapi.json` | Public API contract | Ensure OpenAPI security schemes and examples match route metadata, not just path/method. | OpenAPI consumers can see auth, errors, schemas, and examples for every route. |
| `src/envelope.js` | Canonical success/error envelope exists, but router quick scan showed zero `errorEnvelope(` calls and only 32 `okEnvelope`/header uses | Adopt envelope helpers through route middleware or route wrappers, keeping legacy fields only as compatibility aliases. | Every API route returns typed success/error envelopes with surface, journey, readiness, tenant, evidence, next action, and request ID. |
| `scripts/build-api-contract-matrix.cjs` | Missing | Generate route contract metadata by joining router definitions, OpenAPI, product surfaces, account pages, CLI commands, auth/security policy, schemas, and examples. | `verify:api-contracts` blocks ownerless or schema-less routes. |
| `docs/internal/api-contract-matrix.json` | Missing | Record all 582 routes with owner, surface, journey, schemas, examples, auth, idempotency, audit, state model, and production smoke. | API docs, OpenAPI, SDKs, account pages, and CLI commands agree on route behavior. |
| `docs/internal/route-security-matrix.json` | Missing | Record auth method, tenant scope, object authorization, role/plan requirement, rate/resource class, SSRF/upstream policy, and secret policy per route. | No `/v1/*` route has empty or implied security policy. |
| `docs/internal/api-error-catalog.json` | Missing | Record stable error/problem types, HTTP status, retryability, safe user detail, support/debug reference, account/docs next action, and redaction policy. | API clients and account pages can render errors consistently without parsing strings. |
| `docs/internal/idempotency-matrix.json` | Missing | Record mutating route idempotency policy, key requirements, replay behavior, conflict behavior, and audit event mapping. | Retried create/promote/deploy/delete/purge/rotate calls are safe or explicitly non-retryable. |
| `public/docs/api-routes.json` parser compatibility | Node parsed it, but PowerShell `ConvertFrom-Json` failed in this shell | Add generated JSON compatibility checks and corruption/mojibake tests for committed JSON artifacts. | API artifacts parse with the declared supported toolchain and never contain bad control/mojibake markers. |
| `public/openapi.json` operation security | Only 3 of 586 operations carry OpenAPI `security` in quick parse | Generate operation-level security and explicit public `security: []` from the route security matrix. | OpenAPI accurately tells SDKs and customers which operations require bearer/API key auth. |
| `public/openapi.json` mutating request bodies | 282 mutating operations lacked `requestBody` in quick parse | Add request schemas or explicit empty-body markers for every mutating operation. | SDK generation and account forms do not guess payload shape. |
| `src/compute/backends/*.js` | Multiple env-token and local process execution surfaces | Add credential redaction, resource caps, spawn allowlists, timeout defaults, and readiness truth per backend. | Compute readiness and execution cannot leak secrets or spawn unbounded commands. |
| `src/gateway-mode.js` | Mock/local gateway mode exists | Ensure mock mode is impossible to mistake for production traffic and is visibly labeled in API/account/CLI. | Production evidence fails if mock mode is enabled outside an allowed local/test context. |
| `src/daemon-connector.js` | Connector handles redaction/reinsertion and mock upstreams | Require threat model for sensitive data reinsertion, connector permissions, and mock/live state. | Connector docs/account surfaces show data boundary and live/mock mode clearly. |
| `src/compile-pipeline.js` | Placeholder eval provenance appears intentionally | Ensure placeholder evals cannot become production-ready and account UI explains why. | Compile outputs expose real_eval vs placeholder provenance and block overclaims. |
| `package.json` | `verify:control-files` exists but is not included in `verify:depth`; final/account/production verifiers missing | Wire control/final/account/production verifiers after their builders exist. | Final gate cannot pass while control artifacts drift or final redline is red. |
| `package.json` scripts | `verify:depth` is a very long shell chain and `build:control-files` is partial | Replace with manifest-driven `build:all`, `verify:build-graph`, `verify:generated-artifacts`, and generated `verify:depth` composition. | Package scripts describe the same DAG as `docs/internal/build-graph.json`. |
| `scripts/release-verify.cjs` | Monolithic release verifier can become another hidden authority | Make it consume final redline, build graph, source boundary, generated artifacts, production evidence, and package provenance rather than duplicating private logic. | `release:verify` explains every blocker with path, owner, product surface, and required fix. |
| `reports/ui-surface-audit/` | Generated UI evidence accumulates in dated folders | Add retention and freshness rules; keep only intentional evidence or move old reports outside release source. | Final evidence packet cites current reports only and file ledger flags stale report sprawl. |
| `public/nav.js` | 49 KB global navigation script with only partial manifest evidence | Move nav groups, labels, hrefs, active rules, mobile behavior, and account/docs mapping into a generated navigation manifest. | Nav, sitemap, docs IA, and account matrix agree. |
| `public/sitemap.xml` | 64 KB discovery artifact | Generate from page registry and exclude archive/internal/unowned pages. | Sitemap has only canonical public URLs with current metadata. |
| `public/llms.txt` | 15 KB AI-discovery file | Generate from product/docs registry and ensure claims match readiness closeout. | AI discovery cannot repeat stale or external-gated claims as shipped. |
| `public/.well-known/ai-context.json` | AI context exists; root `public/ai-context.json` missing in quick file check | Decide canonical location and generate all required discovery aliases or redirects. | AI context files match pricing/product/docs/catalog truth. |
| `public/defense.html` | Missing H1 in quick scan | Add canonical H1 and page-family metadata. | Accessibility/SEO scan reports H1 present. |
| `public/enterprise.html` | Missing H1 in quick scan | Add canonical H1 and scoped enterprise compliance language. | Enterprise first screen states outcome, buyer, proof, and sales path. |
| `public/finance.html` | Missing H1 in quick scan | Add canonical H1 and scoped finance/model-risk outcome. | Page family contract validates use-case page structure. |
| `public/health-insurance.html` | Missing H1 in quick scan | Add canonical H1 and scoped payor workflow outcome. | Page family contract validates use-case page structure. |
| `public/healthcare.html` | Missing H1 in quick scan | Add canonical H1 and scoped healthcare/PHI outcome. | Page family contract validates use-case page structure. |
| `public/legal.html` | Missing H1 in quick scan | Add canonical H1 and scoped privilege/on-prem outcome. | Page family contract validates use-case page structure. |
| `public/quickstart.html` | Missing H1 in quick scan | Add canonical H1 and keep quickstart runnable. | Docs scan sees H1 plus expected command outputs. |
| `public/security/membership-inference.html` | Missing main/skip-link signal in quick scan | Move onto canonical page shell. | Accessibility scan reports main landmark and skip path. |
| `public/design-system.html` | Missing main/skip-link signal in quick scan | Decide if internal, public docs, or archive; add canonical shell if retained. | Page registry classifies and accessibility scan passes. |
| `.github/workflows/*.yml` | 11 workflows; missing explicit hardening in quick scan | Add permissions, concurrency, OIDC/provenance where relevant, action pinning policy, and safe secret boundaries. | CI hardening report passes and release packet records workflow provenance. |
| `.github/actions/*/action.yml` | 4 local composite actions with shell steps | Add input validation, shell quoting, versioning, and usage docs. | Composite action audit passes with no untrusted shell injection path. |
| `packages/*/package.json` | Mixed build/test coverage and no publishConfig in quick scan | Add build/test/package/provenance metadata or mark source-only. | SDK release matrix shows no unknown package state. |
| `sdk/*/package.json` | Mixed build/test/publish state across SDKs | Add SDK-specific install/build/test/docs/provenance status. | SDK docs and package state match. |
| `sdk/rust/target/` | Large build outputs in workspace | Exclude from source/release tree and move generated binaries into intentional release artifacts only. | File ledger and git status show no build target leakage. |
| `vercel.json` | 57 KB deploy route/config surface | Generate or verify route/function/header/redirect parity with API and page registry. | Deploy topology confirms Vercel config matches app routes. |
| `.vercelignore` | Deployment exclusion surface currently modified | Verify it excludes internal docs, reports, env, tmp, build outputs, and local data while keeping required public assets. | Deployment include/exclude report is green. |
| `railway.toml` | Secondary deploy target exists | Declare whether Railway is production, backend-only, staging, or legacy. | Deploy topology names ownership and smoke path. |
| `Dockerfile` | Container path exists | Add reproducible image build metadata, healthcheck strategy, non-root user if applicable, and SBOM/provenance. | Container release evidence includes image digest and SBOM. |
| `.env`, `.env.cloudflare`, `.env.local`, `tmp/kolm-launch-*/*.env*` | Local env files exist in workspace | Keep ignored/quarantined, scan for accidental inclusion, and never include in deployment/reports. | Secret inventory reports no tracked or shipped secrets. |
| `package-lock.json` | Dependency lock exists | Include hash in release evidence and run dependency/provenance checks. | Release packet records lockfile hash, audit state, and SBOM. |
| `data/observations.json` | About 174 MB local capture/event data | Classify as local customer-like data, fixture, or disposable; never ship accidentally. | Data inventory marks retention, sensitivity, tenant scope, and release exclusion. |
| `data/observations.json.bak` and `data/observations*.tmp` | Multiple about-174 MB backup/temp copies | Replace ad hoc backups with managed rotation or quarantine/delete. | File ledger and data inventory show zero unmanaged backups in release source. |
| `data/kolm.sqlite`, `data/kolm.sqlite-wal`, `data/kolm.sqlite-shm` | Local SQLite state with WAL/SHM | Document schema, migration, backup, retention, encryption, and release exclusion. | Data inventory and deploy topology classify database state. |
| `data/tenants.json`, `data/teams.json`, `data/team_members.json`, `data/team_invites.json` | Tenant/team state files and backups | Bind to tenant/RBAC matrix and data retention/offboarding rules. | Tenant matrix proves access model and lifecycle states. |
| `data/audit_events.json` | Audit log state and backup | Define immutable audit retention/export/redaction policy. | Audit export and retention flows are state-complete. |
| `data/compile_jobs.json`, `data/active_learning_queue.json`, `data/invocations.json` | Product workflow state and backups | Define workflow retention, retry, cancellation, export, and tenant scope. | Account matrix shows workflow states and cleanup behavior. |
| `src/store.js` | Core persistence helper candidate | Establish whether this is canonical storage abstraction or legacy helper. | All persistence modules use an approved storage abstraction. |
| `src/audit-retention.js` | Retention logic exists | Bind retention policy to data inventory and account/admin settings. | Retention rules are visible, testable, and exportable. |
| `src/audit-export.js` | Audit export logic exists | Ensure export format, redaction, tenant scope, and legal hold behavior are explicit. | Account audit export works with success/error/empty/partial states. |
| `src/auth.js` | Auth logic exists | Map auth/session/key behavior to ASVS-style controls and tenant/RBAC matrix. | Auth routes and account states share one lifecycle contract. |
| `src/billing-upgrade.js` | Billing/upgrade logic exists | Bind to billing lifecycle matrix and pricing/CTA rules. | No plan copy or checkout route drifts from billing source. |
| `src/data-residency.js` | Data residency logic exists | Bind residency choices to storage, account UI, legal docs, and deployment regions. | Enterprise UI shows region/residency state truthfully. |
| `/v1/account/delete`, `/v1/storage/purge`, export routes | Destructive/privacy-sensitive mutating routes | Require confirmation, idempotency, audit, legal-hold behavior, and visible status. | Mutating route matrix proves safe lifecycle handling. |
| `src/distill-pipeline.js` | 55 KB distillation core | Bind every distillation strategy to evidence, data rights, teacher/student metadata, K-Score, failure modes, and artifact output. | Distillation method matrix has zero unknown modes. |
| `src/compile-pipeline.js` | 45 KB compile core with explicit placeholder eval provenance handling | Ensure compile cannot mark artifacts production-ready without real eval/signed artifact/runtime target evidence. | Artifact readiness gate blocks placeholder/unknown eval provenance. |
| `src/artifact.js` | 122 KB artifact builder | Split or formally index manifest/provenance/signature/runtime/eval/model-card sections. | Artifact schema and model card outputs are complete and externally verifiable. |
| `src/artifact-runner.js` | Runtime execution core | Add sandbox, resource caps, telemetry, runtime compatibility, and result provenance contract. | Runtime matrix proves safe execution per target. |
| `src/device-capabilities.js` | Device capability logic | Bind device detection to runtime/device matrix and real fit/fallback decisions. | Account device UI proves fit, fallback, and unsupported states. |
| `src/devices.js` | Device install/fleet logic | Add install/uninstall/test/rollback lifecycle, auth, audit, and compatibility evidence. | Device routes and account page are state-complete. |
| `src/quantization-oracle.js` | Quantization recommendation logic | Add calibration, accuracy delta, runtime/device target, and benchmark evidence requirements. | Quantization recommendations show proof and caveats. |
| `src/runtime-placement.js` | Runtime placement logic | Tie placement to cost, latency, memory, device, storage, governance, and region constraints. | Runtime decision routes show explainable placement and tradeoffs. |
| `cli/kolm.js` quickstart paths | Quickstart currently exposes `wrapper` and `studio`, not the three product surfaces | Add or remap first-class `capture`, `distill`, and `run` golden paths with concise progress, JSON summaries, and exact account/docs handoff. | New users can complete each core product loop from CLI without reading internal wave docs. |
| `cli/kolm.js` build command | First-run build can produce an artifact but exit non-zero because it is sample-only and not production-ready | Split result state into `artifact_built`, `sample_only`, `production_ready`, `verify_ok`, `next_required_action`, and `safe_to_promote`; keep exit code policy explicit. | CI and humans can tell built-but-not-promotable from failed-to-build. |
| `cli/kolm.js` next command | Recommendations use local state and include generated timestamps; stderr can include runtime warnings | Add recommendation provenance, freshness, workspace scope, typed warning suppression, and account linkbacks. | `kolm next --json` is actionable, stable, and warning-clean for scripts. |
| `scripts/build-golden-paths.cjs` | Missing | Generate `docs/internal/golden-paths.json` from CLI/account/docs/API/product graph mappings. | Every golden path has commands, account pages, API routes, docs, states, proof asset, and release gate. |
| `docs/internal/golden-paths.json` | Missing | Record the capture, distill, and run/govern loops as product-owned implementation contracts. | Account, docs, CLI, homepage CTAs, and final redline can prove each loop is covered. |
| `public/quickstart.html` and `public/docs/quickstart/*` | Quickstart must teach three core outcomes, not just install/setup | Rebuild quickstart IA around capture, distill, and run/govern with runnable examples and sample-vs-production caveats. | Docs quickstart and CLI quickstart agree line-for-line on first commands. |
| `public/account/*` golden-path entrypoints | Account surfaces are broad and may not present one obvious next action per product loop | Add a generated "continue this path" module for capture, distill, and run/govern states. | A post-auth user always sees one primary next step per active loop. |
| `src/benchmark-evidence.js` | Benchmark evidence logic exists | Complete required public provider matrix and raw benchmark reports. | Benchmark evidence matrix is public-ready and dated. |
| `src/kscore.js` | K-Score core | Bind K-Score to calibration data, task scope, confidence, and benchmark rows. | K-Score UI/docs avoid uncalibrated universal claims. |
| `src/quality-calibration.js` | Quality calibration logic | Add human-label corpus, drift, judge versioning, and false-accept/false-reject evidence. | Quality calibration report is reproducible. |
| `src/redaction-benchmark.js` | Redaction benchmark logic | Keep benchmark fixture, class metrics, false positive/negative examples, and public report aligned. | Privacy/redaction pages cite current benchmark evidence only. |
| `docs/internal/catalog-manifest.json` | 132 entries but only 4 providers and 4 runtimes | Promote catalog to canonical provider/model/runtime/device registry and freshness gate. | Website/account/docs/API consume one catalog. |
| `src/compute/registry.json` | 21 compute backends | Add per-backend readiness, credential, legal/provider terms, cost, region, resource caps, and smoke status. | Compute account/CLI readiness shows honest backend capability. |
| `public/distill.html`, `public/compile.html`, `public/runtimes.html`, `public/device-transfer.html`, `public/models.html`, `public/benchmarks.html`, `public/k-score.html` | Public AI product pages | Bind each page to AI capability matrix, proof asset, claim scope, and product CTA. | Page-family contracts prove no AI surface is marketing-only. |
| `tests/wave594-kolm-brand-contract.test.js` | Brand gate covers only backend-owned source roots and selected docs | Expand into a release-wide brand/package identity gate using `docs/internal/brand-package-identity.json` and archive exclusions. | Public/docs/account/package/deploy surfaces cannot reintroduce old names or stale package commands. |
| `cli/kolm.js` | Still contains hints mentioning the `kolmogorov-stack` repo | Replace with canonical install/source guidance from the package identity matrix. | CLI error hints match current package/repo decision. |
| `public/docs/quickstart/index.html`, `public/docs/quickstart/node.html`, `public/docs/quickstart/mcp.html` | Tracked docs still advertise `@kolmogorov/sdk` and `@kolmogorov/mcp` style installs | Regenerate quickstarts from canonical package metadata or label source-preview paths honestly. | Quickstart install commands work or state package is source-preview/not shipped. |
| `public/docs/cookbook/coding-assistant.html`, `public/docs/cookbook/document-extractor.html`, `public/docs/cookbook/support-bot.html` | Cookbook install examples still use old `@kolmogorov/cli` package names | Generate cookbook prerequisites from the package identity matrix. | Cookbook pages cannot drift from actual package names. |
| `public/docs/marketplace-import.html` | Shows `npm install @kolmogorov/sdk` and imports from `@kolmogorov/sdk` | Replace with canonical SDK import/package or mark marketplace SDK import as not shipped. | Marketplace import guide works with current package metadata. |
| `public/**/*.html`, `public/**/*.json`, `public/**/*.txt` | Many public/account/docs files link to `sneaky-hippo/kolmogorov-stack` | Centralize GitHub URL through a generated constant or migrate all links after repo rename. | Public link scan shows only approved canonical repo URLs. |
| `infra/aws-marketplace/cloudformation.yaml` | Install fallback still references `github:sneaky-hippo/kolmogorov-stack` | Update CloudFormation install path after package/repo decision and add smoke for fresh instance install. | Marketplace deployment no longer depends on an undocumented old-name fallback. |
| `package.json`, `packages/*/package.json`, `sdk/*/package.json`, `workers/*/package.json` | Package names are mostly Kolm but not governed by one matrix | Add package identity, publication state, repository URL, `files`, `bin`, and provenance status for every package. | Package release matrix and public docs agree. |
| `docs/research/*2026-05-12*.csv`, `_audit/*.md`, `FINAL_*AUDIT*.md` | Historical docs preserve old naming observations and may be useful as evidence | Classify as historical/archive or promote unresolved rows into current redlines. | Final release package excludes historical old-name noise unless explicitly included as archive evidence. |
| `apps/trainer/` | Python trainer with optional GPU path | Add reproducible env lock/constraints, CPU dry-run, GPU doctor, job schema, artifact output contract, telemetry, and explicit missing-toolchain failures. | Trainer smoke produces either a real artifact/eval bundle or a typed blocked state. |
| `apps/runtime/` | Python runtime experimentation and serving code | Decide supported runtime modes; add entrypoints, readiness, resource caps, request schema, latency/cost/quality telemetry, and artifact compatibility checks. | Runtime smoke serves a known artifact and returns traceable provenance. |
| `apps/export/` | Export code for Core ML, ExecuTorch, GGUF, MLX, ONNX, TensorRT, model cards, SBOM, AI Act docs | Make every exporter return signed provenance, dependency versions, target compatibility, failure reasons, and artifact hashes. | Export matrix proves each advertised target can build or is clearly blocked. |
| `apps/import/` | Import code for GGUF, ONNX, safetensors | Add license/provenance capture, schema validation, safety limits, malformed-file handling, and artifact conversion receipts. | Import smoke converts valid fixtures and rejects bad fixtures safely. |
| `apps/eval/` | Python judge/eval packs | Tie judges to K-Score calibration, judge versioning, prompt/data redaction, and human-label comparison. | Eval outputs are scoped, reproducible, and cannot masquerade as public benchmark proof. |
| `workers/distill/` | Isolated distillation worker with `stub` mode | Rename/reframe stub as fixture-only, add run/package/smoke contracts, teacher credential boundaries, and artifact output upload path. | Production cannot consume fixture distill results as trained artifacts. |
| `workers/quantize/` | Isolated quantization worker with many optional methods | Add method-level doctor/run/smoke, calibration datasets, accuracy deltas, target runtime compatibility, and model license checks. | Quantization UI/CLI shows which methods are actually runnable in the current env. |
| `workers/compile-server/` | Server, Docker, and Helm deployment surface | Add package manifest or explicit non-package decision, health/readiness routes, non-root Docker image, resource limits, secret mounts, OTEL, artifact storage, and rollback. | Kubernetes/Docker smoke proves compile-server starts, compiles a fixture, and emits telemetry. |
| `workers/*tokenize*`, `workers/multimodal-redact-*`, `workers/media-redact/` | Multimodal tokenizer/redaction worker family | Standardize input/output schema, file limits, MIME validation, redaction class metrics, privacy boundaries, and error states. | Multimodal smoke covers image/audio/video success, rejection, and redaction evidence. |
| `workers/tsac/`, `workers/itkv/`, `workers/runtime-build/`, `workers/constrained/` | Runtime optimization worker family | Tie each optimization to artifact compatibility, benchmark evidence, fallback behavior, and safety limits. | Optimization matrix proves when to apply, when to skip, and why. |
| `services/mcp/server.js` | MCP service surface | Add production/labs classification, auth, tenant scoping, tool allowlist, rate limits, audit logging, secret redaction, and prompt/data boundary controls. | MCP smoke proves authorized tool use and rejects unauthorized/unsafe calls. |
| `apps/**/__pycache__/`, `scripts/__pycache__/`, `*.pyc` | Python bytecode caches in repo tree | Remove from release source and enforce ignore/source-boundary policy. | File ledger reports zero cache artifacts in release-relevant tree. |
| `*.bak`, `*.tmp`, `*.log`, `*.sqlite-wal`, `*.sqlite-shm` | Backup/temp/log/database runtime artifacts present in workspace | Classify, quarantine, ignore, or transform into managed data artifacts. | Source-boundary manifest reports zero unmanaged runtime artifacts. |
| `archive/prod-snapshot-2026-05-22/` | Full production snapshot in repo tree | Move to release evidence storage or mark as historical archive excluded from public routing, sitemap, deploy, and final source count. | Page registry and deploy include/exclude report ignore archive pages. |
| `reports/`, `screenshots/`, `audit-shots/`, `.shots/`, `.ui-debug/`, `tmp-screenshots/` | Local evidence/output directories | Keep as generated reports only, not source; add retention and naming rules. | Final release source contains no stale screenshot/report output unless explicitly referenced by evidence packet. |

## Implementation Redline By Product Surface

Every product surface must close actual behavior, not just page presence.

| surface | code must do | do not accept |
|---|---|---|
| Route/capture | OpenAI-compatible route, provider selection, capture, cost view, artifact opportunity, account state, CLI path, docs path. | Marketing page only, mock demo only, or provider readiness without a working capture flow. |
| Distill/compile | Teacher/student setup, distill plan/run, K-Score/failure report, compile/sign/verify, artifact output, reproducible receipt. | Research roadmap only, synthetic lift only, or tests that do not produce an artifact. |
| Run/govern | Runtime target selection, cloud/storage readiness, deploy/run path, audit export, governance policy, rollback/telemetry. | "Run anywhere" copy without runtime/device/storage evidence. |

## Product Feature Completion Contract

Every product feature row in the final matrix must include these fields:

- `surface`: route-capture, distill-compile, or run-govern.
- `journey`: the product journey it belongs to.
- `public_pages`: all unauthenticated pages that explain or sell it.
- `account_pages`: all post-auth pages that operate it.
- `api_routes`: all routes required for real behavior.
- `cli_commands`: command-line equivalent or explicit no-CLI reason.
- `docs_pages`: quickstart, guide, API reference, SDK docs, and troubleshooting.
- `state_model`: loading, empty, error, partial, missing credential, no auth, success, disabled, external-gated.
- `data_model`: persistence, tenancy, retention, export, and deletion behavior.
- `proof_asset`: video, screenshot, live demo, artifact receipt, benchmark report, or generated evidence packet.
- `claim_scope`: shipped, local-only, external-gated, planned, deprecated, or archived.
- `ui_contract`: page family, component set, responsive behavior, accessibility target, and performance budget.
- `release_gate`: the command or production evidence that proves this feature works after deploy.

If a feature cannot fill these fields, it is not finished. If the field is filled only with a test name, it is still not finished unless the actual product behavior exists.

## Golden Path Completion Contract

Kolm is not finished until a new qualified user can complete three production-relevant loops without reading internal research docs, wave IDs, or route catalogs. The current CLI proves many pieces exist, but the loops are still too broad, noisy, and internally named.

### Golden Path 1: Replace One AI API And Capture Owned Traffic

Required product behavior:

- Start from homepage, quickstart, docs, CLI, or account and land on the same route/capture path.
- Connect one OpenAI-compatible provider with explicit local/mock/live mode.
- Paste or run one real OpenAI-style call.
- Capture request, response, cost, latency, provider, model, redaction state, and tenant/workspace.
- Show the captured call in account.
- Promote the call into a dataset candidate.
- Show the first savings/opportunity recommendation with evidence.
- Export or compile the first `.kolm` artifact candidate with honest sample/prod status.

Required code work:

- Add `kolm quickstart capture` or make `quickstart wrapper` explicitly become the capture golden path.
- Add `scripts/build-golden-paths.cjs` and `docs/internal/golden-paths.json`.
- Add account page states for no provider, provider configured, first capture, redaction warning, opportunity available, candidate promoted, artifact sample-only, and production-ready.
- Add API route correlation IDs from gateway request to account capture row to dataset candidate to artifact.
- Add docs tutorial that uses the exact same command sequence as the CLI.

Done when: a fresh user can produce and inspect one captured call and one artifact candidate, and every screen says whether it is sample-only or production-ready.

### Golden Path 2: Compile And Distill A Task Model

Required product behavior:

- Start from task description or dataset.
- Select teacher, student/backbone, data source, privacy policy, compute target, and K-Score gate.
- Run a local dry-run first, then a real worker/cloud path if credentials are configured.
- Produce artifact, distillation receipt, K-Score/failure report, and production readiness verdict.
- Explain every blocker in terms of data size, holdout split, calibration, privacy, compute, or missing credentials.
- Route the next action to exactly one place: add data, fix failing cases, choose compute, change student, or promote artifact.

Required code work:

- Add `kolm quickstart distill` as a distinct path; do not bury distillation under generic build/studio language.
- Make `kolm build --json` distinguish `artifact_built`, `sample_only`, `production_ready`, `verify_ok`, `next_required_action`, and `safe_to_promote`.
- Make K-Score output always include calibration status, human-preference mapping status, data provenance, and "do not use for production" copy when applicable.
- Add account states for strategy selected, worker unavailable, cloud credentials missing, sample artifact built, failed gate, passed gate, and promote/rollback.
- Add public/docs examples that produce a real artifact in a temp project and then show how to replace placeholders with real rows.

Done when: a first-run build can fail production readiness without feeling like a broken product, and a real-data run can pass with a traceable artifact.

### Golden Path 3: Run Anywhere With Governance

Required product behavior:

- Start from a `.kolm` artifact.
- Choose local, browser, device, cloud, BYOC, or air-gapped target.
- Check runtime/device/storage/provider readiness before deployment.
- Run one input and show output, receipt, latency, cost, trace, and rollback/supersession status.
- Export audit/compliance evidence without leaking secrets or tenant data.
- Show clear local-only, cloud-ready, package-gated, certification-gated, or partner-gated status.

Required code work:

- Add `kolm quickstart run` or `kolm quickstart deploy` as a distinct path.
- Bind `kolm cloud storage --json`, compute readiness, device readiness, artifact verification, and account deployment state into one runtime placement view.
- Add account states for no artifact, artifact sample-only, runtime incompatible, storage local-only, cloud missing credentials, deployment ready, deployed, failed, rolled back, superseded, and audit exported.
- Add typed error classes and retryability for deployment, storage, provider, device, and audit export failures.
- Add production screenshots and live smoke that prove local and at least one configured cloud/storage path after deploy.

Done when: "run anywhere" is not a slogan; the account and CLI can say exactly where this artifact can run right now, why, and what proof exists.

### Golden Path UX Rules

- Top-level help may stay broad, but default onboarding must show only the three golden paths first.
- Every path must have `--json` for machines and concise human output for people.
- Every path must use stdout for primary results and stderr for logs/warnings.
- Every warning must include a typed code, next action, and owning surface.
- Every placeholder/sample result must be visually and structurally impossible to confuse with production readiness.
- Every path must have matching homepage CTA, docs tutorial, account entrypoint, API route set, CLI command, and final evidence gate.

## How To Execute This Redline

Pick a redline and change code. Do not spend another cycle creating a meta-plan for the redline.

Execution rule:

```text
1. Touch the implementation file named by the redline.
2. Create or update the named source-of-truth module/manifest/generator.
3. Delete or replace the stale path named by the redline.
4. Regenerate only the affected derived files.
5. Add the smallest guard that prevents the stale behavior from returning.
```

Do not add more prose unless it directly specifies code to create, replace, delete, move, implement, or wire.

## Final Completion Gate

The codebase is not done until a final redline artifact says:

```json
{
  "ok": true,
  "dirty_paths": 0,
  "unowned_paths": 0,
  "scratch_paths": 0,
  "unregistered_generators": 0,
  "missing_generated_artifacts": 0,
  "stale_generated_artifacts": 0,
  "nondeterministic_release_artifacts": 0,
  "route_owner_gaps": 0,
  "api_contract_blockers": 0,
  "route_security_blockers": 0,
  "idempotency_blockers": 0,
  "account_page_owner_gaps": 0,
  "account_shell_blockers": 0,
  "golden_path_blockers": 0,
  "design_cascade_blockers": 0,
  "product_media_blockers": 0,
  "claim_scope_blockers": 0,
  "production_evidence_blockers": 0
}
```

If any value is not zero, the codebase is not 100 percent finished.

## First Implementation Cuts

These are not checklist items. They are the first code cuts to make the repo stop depending on scattered manual state:

CUT 1: CREATE `src/api/route-contracts.js`, `src/api/register-route.js`, `src/api/problem.js`, `src/api/idempotency.js`, and `src/api/authorization-policy.js`.
Replace direct route registration in `src/router.js` with contract-aware route registration for the highest-value route families first: account, capture, distill, artifacts, runtime, storage, billing, and governance.

CUT 2: REPLACE API docs/OpenAPI generation inputs with route contracts.
`scripts/build-api-ref.cjs` and `scripts/build-openapi.cjs` must read the runtime route contract registry and emit security, schemas, examples, problem responses, idempotency, tenant scope, product surface, account links, CLI links, and SDK examples.

CUT 3: CREATE the account product shell implementation.
Add `public/account/account-shell.js`, `public/account/account-state.js`, `public/account/account-actions.js`, `scripts/build-account-product-matrix.cjs`, and `scripts/build-account-shell-contract.cjs`; replace duplicate account shell fragments with generated shell/state/action ownership.

CUT 4: REPLACE the homepage and public product proof surface.
Extract product-proof components from `public/index.html`, delete hidden wave/demo payloads, and rebuild the first viewport around the three Kolm product surfaces: route/capture, distill/compile, run/govern.

CUT 5: REPLACE fragmented visual styling with canonical design-system code.
Promote durable rules from `public/brand-refresh.css`, `public/surface-polish.css`, `public/home-refresh.css`, and page inline styles into canonical tokens/components; delete the migration rules after pages no longer depend on them.

CUT 6: CREATE source-boundary and build-graph code.
Add `scripts/build-source-boundary-manifest.cjs`, `scripts/build-build-graph.cjs`, `docs/internal/source-boundary-manifest.json`, `docs/internal/build-graph.json`, `docs/internal/generator-registry.json`, `docs/internal/generated-artifact-manifest.json`, and `docs/internal/report-retention-manifest.json`; then make `package.json` build/release scripts consume that graph.

CUT 7: CREATE golden-path implementation contracts.
Add `scripts/build-golden-paths.cjs` and `docs/internal/golden-paths.json`; wire capture, distill, and run/govern through CLI, API, account, docs, homepage CTA, telemetry, and production evidence.

CUT 8: CREATE runtime/worker/package completion matrices.
Add source-of-truth manifests for Python apps, workers, services, SDKs, and packages; mark each as supported, source-preview, labs-only, external-gated, or not shipped; remove public claims that do not match.

CUT 9: CREATE final redline aggregation.
Add `scripts/build-final-redline.cjs` and `reports/build-redline/final-build-redline.json`; this artifact blocks release until code redlines, stale generated outputs, source-boundary violations, API contracts, account shell, design system, media proof, package identity, runtime matrices, and production evidence are closed.

CUT 10: DELETE or MOVE all release-invalid local state.
Move/delete `.w850-shots/`, malformed `site-failures*.txt`, local `*.tmp`, unmanaged `*.bak`, `*.log`, Python caches, SDK build outputs, stale screenshots, and local database WAL/SHM files according to the source-boundary manifest.

The next meaningful progress is code: create the missing modules, replace manual surfaces, delete stale release files, and wire generated truth into the product.

## Referenced Paths

Primary docs:

- `docs/research/kolm-100-percent-finished-code-redline-2026-05-25.md`
- `docs/research/kolm-master-spec-consolidated-review-2026-05-25.md`
- `docs/research/kolm-internal-spec-index-2026-05-25.md`
- `docs/research/kolm-ai-100-percent-codebase-completion-blueprint-2026-05-25.md`
- `docs/research/kolm-codebase-file-ledger-seed-2026-05-25.md`
- `docs/research/kolm-design-cascade-ledger-seed-2026-05-25.md`
- `docs/research/kolm-product-media-proof-seed-2026-05-25.md`
- `docs/research/kolm-product-feature-completion-matrix-seed-2026-05-25.md`
- `docs/research/kolm-account-product-matrix-seed-2026-05-25.md`

Current generated control files:

- `docs/internal/codebase-file-ledger.json`
- `docs/internal/design-cascade-ledger.json`
- `docs/internal/wave-registry.json`
- `docs/internal/wave-registry.schema.json`
- `docs/internal/wave-reconcile-report.json`
- `docs/internal/catalog-manifest.json`
- `docs/internal/product-media-proof.json`

Required generated control files that do not yet exist:

- `docs/internal/source-boundary-manifest.json`
- `docs/internal/build-graph.json`
- `docs/internal/generator-registry.json`
- `docs/internal/generated-artifact-manifest.json`
- `docs/internal/report-retention-manifest.json`
- `docs/internal/api-contract-matrix.json`
- `docs/internal/route-security-matrix.json`
- `docs/internal/api-error-catalog.json`
- `docs/internal/idempotency-matrix.json`
- `docs/internal/golden-paths.json`
- `docs/internal/brand-package-identity.json`
- `docs/internal/account-product-matrix.json`
- `docs/internal/account-shell-contract.json`
- `docs/internal/account-interaction-contract.json`
- `docs/internal/account-state-machine.json`
- `docs/internal/page-family-contracts.json`
- `docs/internal/claim-copy-map.json`
- `docs/internal/python-app-runtime-matrix.json`
- `docs/internal/worker-runtime-matrix.json`
- `docs/internal/service-runtime-matrix.json`
- `reports/build-redline/final-build-redline.json`

Current implementation files requiring redline work:

- `src/router.js`
- `cli/kolm.js`
- `server.js`
- `apps/trainer/`
- `apps/runtime/`
- `apps/export/`
- `apps/import/`
- `apps/eval/`
- `workers/distill/`
- `workers/quantize/`
- `workers/compile-server/`
- `workers/*tokenize*/`
- `workers/multimodal-redact-*/`
- `workers/tsac/`
- `workers/itkv/`
- `services/mcp/server.js`
- `scripts/build-account-pages.cjs`
- `public/index.html`
- `public/pricing.html`
- `public/account/overview.html`
- `.vercelignore`
- `package.json`

Current prototype control builders:

- `scripts/build-codebase-file-ledger.cjs`
- `scripts/build-design-cascade-ledger.cjs`
- `scripts/build-wave-registry.cjs`
- `scripts/build-catalog-manifest.mjs`
- `scripts/build-product-media-proof.cjs`

Required missing builders:

- `scripts/build-account-product-matrix.cjs`
- `scripts/build-page-family-contracts.cjs`
- `scripts/build-claim-copy-map.cjs`
- `scripts/build-production-evidence-packet.cjs`
- `scripts/build-final-redline.cjs`

Required missing outputs:

- `docs/internal/account-product-matrix.json`
- `docs/internal/page-family-contracts.json`
- `docs/internal/claim-copy-map.json`
- `docs/internal/brand-package-identity.json`
- `docs/internal/navigation-manifest.json`
- `docs/internal/page-registry.json`
- `docs/internal/ai-risk-evidence-map.json`
- `docs/internal/observability-contract.json`
- `docs/internal/ci-hardening-report.json`
- `docs/internal/sdk-release-matrix.json`
- `docs/internal/deploy-topology.json`
- `docs/internal/secret-inventory.json`
- `docs/internal/sbom-provenance.json`
- `docs/internal/data-inventory.json`
- `docs/internal/source-boundary-manifest.json`
- `docs/internal/python-app-runtime-matrix.json`
- `docs/internal/worker-runtime-matrix.json`
- `docs/internal/service-runtime-matrix.json`
- `docs/internal/archive-retention-manifest.json`
- `docs/internal/tenant-rbac-matrix.json`
- `docs/internal/billing-lifecycle-matrix.json`
- `docs/internal/mutating-route-contracts.json`
- `docs/internal/ai-capability-matrix.json`
- `docs/internal/distillation-method-matrix.json`
- `docs/internal/runtime-device-matrix.json`
- `docs/internal/benchmark-evidence-matrix.json`
- `reports/deployments/<release-id>/production-evidence.json`
- `reports/build-redline/final-build-redline.json`

Scratch or quarantine paths that must not remain in a release tree:

- `.w850-shots/`
- `C?*site-failures*.txt`
- `data/*.tmp`

## Live Data Plane, Persistence, Env, And Retention Redline

Current local evidence:

- `src/store.js` is the server store facade. It supports only `json` and `sqlite` through `KOLM_STORE_DRIVER`, defaults local development to JSON files, and defaults production-like runtimes to SQLite only when `node:sqlite` is available. It writes JSON durably through temp file, fsync, backup `.bak`, and corruption quarantine. SQLite uses WAL, `synchronous=FULL`, foreign keys, busy timeout, and a generic `kolm_store_rows(table_name, json, created_at, updated_at)` table.
- `src/store-drivers/vercel-postgres.js` and `src/store-drivers/vercel-kv.js` exist, but they are not selectable by the main `src/store.js` facade because that facade rejects every driver except `json` and `sqlite`. This is a real implementation gap, not a documentation nuance.
- `src/env.js` auto-creates production-like `KOLM_DATA_DIR` and `KOLM_ARTIFACT_DIR` defaults under `os.tmpdir()` when explicit dirs are absent. `/ready` can therefore become green for writable temporary storage while still telling operators to override the paths for durable storage.
- `src/event-store.js` is a separate event data plane. It owns a typed `events` table in `~/.kolm/events/events.sqlite` or a JSONL fallback, validates rows through `src/event-schema.js`, and keeps capture/lake events separate from the generic server row store.
- `src/event-schema.js` is stronger than the generic store: it has explicit fields, required fields, closed enums for status/source/vendor/redaction/media state, canonicalization, and fail-closed review defaults.
- `src/audit-retention.js` implements tenant-fenced audit retention with 90 day minimum, 365 day default, 2555 day maximum, dry-run eviction by default, and explicit confirmation for destructive enforcement.
- `src/data-residency.js` implements region tagging and enforcement on top of the event store. It defaults undetermined data to `GLOBAL`, not EU, and requires explicit confirmation to write residency tags.
- `src/secrets-vault.js` implements a local AES-256-GCM vault with `local:`, `env:`, and external secret reference envelopes. The local key is created beside the vault under the Kolm data root. External secret refs are currently intent envelopes; the product stores references but does not prove live AWS/GCP/Azure/Vault/1Password/Doppler/Infisical resolution in the main release gate.
- A source-level env scan found 378 unique direct `process.env.*` variable names across local code. `.env.example` documents only a subset and still contains retired pricing/plan instructions for Stripe Payment Links (`$9`, `$149`, `$1,499`, `$2,999`, Starter, Teams, Business, Ent) while the product contract has moved to Free, Pro `$49`, Team `$499`, and Enterprise custom/contact sales.
- `.gitignore` excludes `.env*`, data files, temp files, screenshots, reports, test output, and local agent directories. `.vercelignore` excludes many of the same paths from Vercel. There is no `.dockerignore`, and `Dockerfile` uses `COPY . .`, so the Docker path has no equivalent release-boundary proof.
- The current root contains local/scratch/release-risk directories and artifacts: `.agent/`, `.claude/`, `.kolm-bundle/`, `.kolm-self-hosted-tmp/`, `.npm-cache/`, `.shots/`, `.tmp/`, `.tmp-w255/`, `.ui-debug/`, `.vercel/`, `archive/`, `audit-shots/`, `backups/`, `data/`, `node_modules/`, `reports/`, `screenshots/`, `tmp/`, `tmp-screenshots/`, `_audit/`, plus prior malformed path/test output artifacts. A clean product build cannot rely on developer discipline to exclude these.

What this means:

The backend has credible local primitives, but the production data plane is not yet finished. It is split across a generic JSON/SQLite store, a stronger typed event store, a local secrets vault, an audit-retention module, and a data-residency module. Those pieces need one generated authority that states which data is durable, which data is temporary, which storage drivers are supported by each runtime, which env vars are required, which secrets may resolve at runtime, what gets backed up, what gets deleted, and what is included in a release image.

Hard redlines:

1. Build `docs/internal/data-plane-contract.json` and `.md`.
   - Inputs: `src/store.js`, `src/event-store.js`, `src/event-schema.js`, `src/store-drivers/*`, `src/object-storage.js`, `src/audit-retention.js`, `src/data-residency.js`, `docs/internal/catalog-manifest.json`, and `public/product-graph.json`.
   - It must classify every persisted table/log/blob as `authoritative`, `derived`, `cache`, `scratch`, `audit`, `artifact`, `secret_reference`, or `test_fixture`.
   - It must declare storage driver support per runtime: local dev, Railway, Vercel static/API rewrite, Docker, self-host, air-gapped, worker, CLI, and test.
   - It must mark `json` as local/single-node only unless `KOLM_ALLOW_JSON_STORE=true` is explicitly in an emergency profile.
   - It must resolve the mismatch between `src/store.js` and `src/store-drivers/*`: either wire supported async drivers through a real facade or demote those drivers to experimental/offline modules in the contract.
   - It must define typed migration ownership for all generic JSON rows. Final state cannot leave major product tables as untyped JSON blobs without field ownership, indexes, tenant fence, migration version, and retention policy.

2. Build `docs/internal/env-secret-contract.json` and `.md`.
   - Inputs: direct env scan, `.env.example`, `src/env.js`, `src/secrets-vault.js`, deploy files, CI scripts, CLI help, provider catalogs, cloud readiness, and object-storage readiness.
   - Every env var must have owner, type, sensitivity, default, valid values, required runtime, public-safe display name, rotation policy, source module, docs page, deploy target, and readiness check.
   - Direct `process.env.*` reads must be classified. Secrets must route through `envSecret()` or a provider-specific resolver; booleans must route through `envBool()` or an equivalent parser.
   - `.env.example` must be generated from this contract, not hand-maintained. It must remove retired Starter/Business/old-price Stripe instructions and reflect Free/Pro/Team/Enterprise sales flow.
   - The local vault must be scoped honestly: acceptable for local/dev/self-host bootstrap, not a replacement for a production secrets manager unless the production evidence packet proves host encryption, key isolation, rotation, audit, and recovery.
   - The contract must fail if a secret value appears in generated public files, logs, reports, screenshots, OpenAPI examples, or account UI responses.

3. Build `docs/internal/data-retention-backup-contract.json` and `.md`.
   - Inputs: `src/audit-retention.js`, `src/event-store.js`, account privacy/export/delete pages, route contracts, object storage, and production evidence.
   - It must state retention per data class: account tenant, API key hash, event/capture, raw media, redacted text, audit event, artifact, benchmark fixture, billing record, support/sales lead, local cache, and generated report.
   - It must define backup, restore, RPO, RTO, restore test cadence, encryption, region, object lock/versioning, legal hold, right-to-erasure exception, and deletion confirmation for each class.
   - Destructive operations must be idempotent, audit-logged, tenant-fenced, dry-run capable, and covered by a restore/rollback story.
   - The final production evidence packet must include an actual restore drill, not only a backup configuration screenshot.

4. Build `docs/internal/tenant-data-boundary-contract.json` and `.md`.
   - Inputs: `src/auth.js`, `src/event-schema.js`, `src/event-store.js`, `src/store.js`, `src/data-residency.js`, account/team/RBAC routes, route contracts, SDKs, and tests.
   - It must define the canonical tenant identifier per table and route. Today the code uses `tenant`, `tenant_id`, tenant name, tenant id, and email in different places; the contract must specify what is allowed and where translation occurs.
   - Every read path must state its tenant fence. Every write path must state how tenant identity is derived, whether cross-tenant admin access is allowed, and what audit row proves it.
   - Export-control and sanctions controls must not be a permanently hardcoded legal source. `src/auth.js` can keep a baseline denylist, but the contract must define owner, legal review cadence, source of truth, override process, and production evidence.
   - Account deletion, export, retention, merge, OAuth claim, team invite, key rotation, artifact publish, and event promotion must each be mapped to tenant-bound data effects.

5. Build `docs/internal/release-boundary-manifest.json` and `.md`.
   - Inputs: `Dockerfile`, `.dockerignore` once created, `.gitignore`, `.vercelignore`, `vercel.json`, `railway.toml`, `package.json`, file ledger, generated artifact manifest, and production evidence.
   - It must declare the exact file inclusion/exclusion policy for Vercel, Railway, Docker, npm packages, SDK packages, browser extension, CLI bundle, and public static assets.
   - Docker must not use an unbounded `COPY . .` without a manifest-backed `.dockerignore` or equivalent build context. The release packet must prove no `.env*`, local data, backups, screenshots, reports, node_modules cache, test output, local agent directories, or malformed temp artifacts enter the image.
   - The file ledger must classify scratch paths as quarantine or release inputs. Anything unclassified blocks `final-build-redline`.

6. Wire all five contracts into `reports/build-redline/final-build-redline.json`.
   - `final-build-redline` must fail unless data plane, env/secrets, retention/backup, tenant boundary, and release boundary are all `pass`.
   - It must list every open external item as `external_blocked`, not `done`.
   - It must show the exact local and production evidence used for the release ID.

External baselines imported into this redline:

- The Twelve-Factor App config rule says deploy-specific config belongs in environment variables and should be strictly separated from code: https://www.12factor.net/config
- OWASP Secrets Management Cheat Sheet requires centralized storage, provisioning, auditing, rotation, and management of secrets rather than scattered plaintext configuration: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- NIST SP 800-53 Rev. 5 contingency planning controls anchor backup, recovery, contingency planning, and resilience evidence for systems that need regulated trust posture: https://csrc.nist.gov/Pubs/sp/800/53/r5/upd1/Final

Implementation owner notes:

- This is not a request to rewrite storage immediately. The first implementation step is to generate the contracts from the current code and fail only on contradictions that can cause data loss, secret leakage, tenant leakage, or false production claims.
- The first code redline after the contracts should be small: reconcile `KOLM_STORE_DRIVER` support so the facade and driver modules agree, generate `.env.example` from the env contract, add `.dockerignore` from the release-boundary manifest, and attach data-plane status to `/ready`, `/v1/product/graph`, account overview, and CLI/TUI surfaces.
- Do not market cloud durability, production secret management, SOC 2 retention, data residency, or Docker release cleanliness until the production evidence packet proves these contracts on the deployed release.

## Live CI, Release, Package, SBOM, And Provenance Redline

Current local evidence:

- `package.json` has many useful scripts: product graph/readiness, five generated control-file checks, reference/href/product-surface lint, kernel/journey/depth gates, local/prod surface smoke, redaction/quality/benchmark/compliance/package-release readiness, UI screenshot audit, full tests, and `release:verify`.
- `scripts/release-verify.cjs` is a serious local release driver. It runs semantic gates for `lint:refs`, seven current control files, OpenAPI sync, browser SDK manifest, full `npm test`, SDK smoke against a local server, local product-surface smokes, CLI doctor/whoami, artifact verification, and billing tiers.
- `release:verify` is still local-first. It does not produce a release ID packet, does not sign or attest the result, does not require production smokes/screenshots/headers/telemetry/rollback, and only knows the first seven generated control files, not the expanded master spec tree.
- `.github/workflows/test-suite.yml` runs Node 20 and `node --test --test-concurrency=1 tests/` for selected path changes. It does not run `verify:depth`, `release:verify`, UI audits, production smokes, package release readiness, provenance verification, or the new control-file tree.
- `.github/workflows/lint.yml` runs static ref/href audits, an `innerHTML` public-template-literal guard, orphan Vercel rewrite check, and `npm audit --omit=dev --audit-level=high`. It installs with `--omit=optional --omit=dev`, so it is not equivalent to the runtime/test install surface.
- `.github/workflows/smoke.yml` starts the local server and runs `scripts/smoke-live.sh`; it is useful but narrow compared with `local:surfaces` and `release:verify`.
- `.github/workflows/sbom.yml` generates CycloneDX via `@cyclonedx/cyclonedx-npm@latest`, generates a Python fallback SBOM in CycloneDX and SPDX shapes, uploads artifacts for 90 days, and opens an issue on CycloneDX failure. It does not attach SBOM hashes to a release packet, sign the SBOM, attest build provenance, verify uploaded artifact integrity, or link SBOM to each package/channel.
- `.github/workflows/sdk-c-rust.yml` gives useful C/Rust checks. Other package channels do not have equivalent publish-grade CI in the workflow set.
- `.github/workflows/kolm.yml` and `.github/workflows/kolm-distill.yml` are intentionally opt-in/reference workflows guarded by missing secrets or `if: false`. They are product examples, not proof that Kolm itself ships with automated distill release gates.
- `.github/actions/kolm-compile/action.yml` and `.github/actions/kolm-publish/action.yml` install from `github:sneaky-hippo/kolm-stack` and use `KOLM_KEY`/API key env. They verify artifacts, but they do not pin a version/tag/digest of the action's CLI dependency or emit provenance for the compiled/published artifact.
- `scripts/package-release-readiness.mjs --summary --require-local-contract` currently reports `ok=true publish_ready=false targets=16 structural_ok=16 pending=16 blocked=0`.
- The 16 package/release targets are `sdk-ts`, `sdk-rn`, `attestation-npm`, `langchain-npm`, `llamaindex-npm`, `sdk-python`, `langchain-python`, `llamaindex-python`, `runtime-rs`, `sdk-swift`, `sdk-kotlin`, `homebrew`, `apt`, `winget`, `install-scripts`, and `browser-extension`.
- Every package-release target is pending channel proof. Current blockers include signed release artifact or registry URL missing for all targets, Homebrew release archive SHA placeholder, and winget installer SHA placeholder.
- `reports/` contains local logs, live-smoke artifacts, and many UI screenshot audit outputs, but there is no `reports/deployments/<release-id>/production-evidence.json`, no `reports/build-redline/final-build-redline.json`, and no release-bound package/SBOM/provenance bundle.

What this means:

Kolm has many gates, but it does not yet have a release control plane. The current system can say "many checks passed locally" and "package manifests structurally exist." It cannot yet say "this exact release artifact, Docker image, static site, API backend, SDK package set, installer set, browser extension, `.kolm` examples, SBOM, and provenance were built from this commit, tested by this matrix, signed/attested, deployed, smoked in production, and retained for audit."

Hard redlines:

1. Build `docs/internal/ci-release-pipeline-contract.json` and `.md`.
   - Inputs: `package.json` scripts, `.github/workflows/*.yml`, `.github/actions/*/action.yml`, `scripts/release-verify.cjs`, `scripts/local-surface-smoke.cjs`, `scripts/prod-surface-smoke.cjs`, `scripts/ui-surface-audit.cjs`, package-readiness scripts, and generated control files.
   - It must declare every CI workflow, trigger, path filter, runtime version, permissions block, secret use, install mode, commands run, artifacts emitted, retention period, and whether the workflow is required, optional, reference-only, or product-template-only.
   - It must distinguish "Kolm product release gate" from "example workflow customers can copy." Reference workflows with `if: false` or manual-only triggers cannot count as product release proof.
   - It must reconcile Node 20 CI with Node 22/24 local/runtime expectations. If Node 20 remains the compatibility target, the contract must say so and prove it; if Node 22+ is required for `node:sqlite`, the CI matrix must include it.
   - It must require least-privilege GitHub permissions, pinned action versions, no unpinned `@latest` in release-critical generation, no unbounded global installs for release proof, and no secret-bearing output.

2. Build `docs/internal/release-artifact-evidence-matrix.json` and `.md`.
   - Inputs: package release readiness, generated artifact manifest, release boundary manifest, SBOM workflow, package manifests, browser extension build, SDK manifests, Docker/Railway/Vercel deploy files, and production evidence.
   - It must list every release subject: static site bundle, Railway/API backend, Docker image, CLI/npm root package, browser SDK, Node SDK, Python SDK, Rust crate, C SDK binary, TypeScript package, React Native package, Swift package, Kotlin/Maven artifact, browser extension, Homebrew formula, winget manifests, apt/deb package, GitHub Actions, and sample `.kolm` artifacts.
   - For every subject it must require commit SHA, version, build command, source inputs, output path, SHA-256, SBOM SHA-256, provenance SHA-256, signature/attestation bundle SHA-256, registry or artifact URL, local checks, production/channel checks, owner, and retention.
   - Package-release readiness is not complete until `publish_ready=true` or the target is explicitly marked `not_released` with public copy/docs saying it is local-source only.
   - Placeholder hashes in Homebrew/winget/installer/package metadata must fail the final build redline.

3. Build `docs/internal/sbom-provenance-contract.json` and `.md`.
   - Inputs: `.github/workflows/sbom.yml`, `apps/export/sbom.py`, package lockfiles, package release manifest, Docker/static/backend build outputs, SLSA/CycloneDX/SPDX/in-toto/GitHub attestation outputs.
   - It must define required SBOM format per target. Node/dependency surfaces can use CycloneDX and SPDX; installable binaries/images/extensions must have target-specific SBOM subject references and hashes.
   - It must require that SBOM artifacts are release artifacts, not loose workflow uploads. They need release ID, subject digest, generator identity, validation result, retention, and link from the production evidence packet.
   - It must require provenance attestations for packages, images, browser extension zips, release archives, and generated SDK bundles.
   - It must verify provenance, not only emit it. The final redline should include a command or report that validates each attestation against the expected repository, commit, workflow, and subject digest.

4. Build `docs/internal/ci-required-checks-policy.json` and `.md`.
   - Inputs: GitHub workflows, branch protection expectations, release scripts, package release readiness, security release contract, and active lane registry.
   - It must say which checks are required before merge, before release candidate, before production deploy, and after production deploy.
   - Required checks should include current control files plus the new data-plane, env/secrets, retention, tenant boundary, release boundary, API contracts, OpenAPI policy, SDK parity, docs IA, feature matrix, account matrix, page-family/nav/component contracts, generated artifacts, observability, security release, package release, SBOM/provenance, local surfaces, production surfaces, UI screenshots, and final redline.
   - It must define flake policy, retry policy, timeout policy, artifact retention, owner escalation, and what can be skipped with a signed exception.

5. Extend `scripts/release-verify.cjs` only after the contracts exist.
   - It should consume the generated control files rather than hardcoding seven legacy control files.
   - It should write `reports/build-redline/local-release-verify.json` with gate details, versions, command output pointers, and no secrets.
   - It should have a separate production mode that consumes `reports/deployments/<release-id>/production-evidence.json`, not a local-mode flag that pretends production was proved.

External baselines imported into this redline:

- GitHub Artifact Attestations can establish build provenance for binaries and container images in GitHub Actions: https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds
- npm provenance documents provenance attestations for packages published from supported CI systems: https://docs.npmjs.com/generating-provenance-statements
- CycloneDX is a machine-readable BOM standard and supports SBOM and related BOM types: https://cyclonedx.org/specification/overview
- SLSA v1.1 defines provenance levels and recommended attestation formats for software supply-chain integrity: https://slsa.dev/spec/
- OpenSSF Scorecard exists to automatically assess open-source project security posture and should be tracked as an external hygiene signal, not a substitute for Kolm's own release evidence: https://openssf.org/scorecard/

Implementation owner notes:

- Do not replace working local gates. Wrap them in a release evidence model that captures subjects, outputs, hashes, attestations, and production proof.
- The first build agent should implement the new contracts in read-only/warn mode, then fail on only three things first: missing release subjects, placeholder hashes, and secret leakage in release artifacts.
- The second build agent should update CI to run the contract verifiers and emit artifacts, then only after that tighten branch/release requirements.
