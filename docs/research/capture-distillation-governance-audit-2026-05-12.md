# Capture And Distillation Governance Audit - 2026-05-12

## Scope

This pass reviews the capture-to-distillation pipeline: provider proxy capture, direct observation logging, capture inbox, label export, bridge auto-synthesis, specialist training, auto-distill, local tune, CLI helpers, SDK helpers, public capture pages, and existing test coverage.

Reviewed local sources:

- `src/router.js`
- `src/capture.js`
- `src/synthesis.js`
- `src/tune.js`
- `cli/kolm.js`
- `public/captures.html`
- `public/api.html`
- `public/evolve.html`
- `public/glossary.html`
- `public/vs-openpipe.html`
- `docs/TUNE.md`
- `docs/EVOLVE.md`
- `sdk/node/index.mjs`
- `sdk/node/test/sdk.test.mjs`
- `sdk/mcp/server.mjs`
- `tests/*.test.js`

## Executive Findings

The capture-to-distillation story is directionally coherent, but the current implementation is a set of partially connected loops rather than one governed flywheel.

The provider proxy captures are stored under `corpus_namespace`, while the captures inbox reads and filters `namespace`. As a result, proxy captures sent with `x-kolm-namespace` can show up in the inbox as `default`, cannot be filtered by their real namespace there, and can make the inbox claim `default` is ready even though `POST /v1/specialists/auto-distill` looks at `corpus_namespace` and will not count those rows under `default`.

The triage controls are not connected to the training/export paths. `/v1/bridges/observations/:id` can mark an observation as `kept` or `discarded`, and the inbox hides discarded rows by default. But `/v1/labels/synthesize-corpus` and `/v1/specialists/auto-distill` filter only by tenant and `corpus_namespace`; they do not exclude `discarded`, require `kept`, or filter by successful upstream status. The public page says discard removes an observation from training, but the backend still exports and counts it.

Failed provider calls can become training examples. `forwardOpenAI` and `forwardAnthropic` return a 401 JSON error when `x-upstream-api-key` is missing. The route still calls `recordCapture`, stores a response such as `[error] ...`, sets the HTTP status to 401, and those rows are counted by labels/export and auto-distill unless manually excluded elsewhere.

Bridge auto-synthesis does not actually persist the synthesized concept. `POST /v1/bridges/auto-synthesize` calls `synthesize` directly and returns the synthesis result. `synthesize` returns source/evaluation but does not create a registry concept or version. The route then writes `promoted_recipe_id: synthResult.concept_id`, but `concept_id` is not part of the `synthesize` result. The route can therefore report accepted synthesis without creating the thing the route comment says it promoted.

Auto-distill is bridge-gated and has no visible completion integration in the app. `POST /v1/specialists/auto-distill` requires 1,000 captured pairs and then returns 503 unless `KOLM_TRAINER_BRIDGE_URL` is configured. If configured, it posts to an external `/distill` endpoint with a callback URL, but no callback route was found in `src/router.js`; no local specialist record, compile job, weights URL, artifact URL, or receipt is created by this route.

The local tune loop is separate from cloud capture and currently does not prove adapter improvement. `kolm tune capture-on` writes local `captures.jsonl`, and `kolm tune step` can create adapter revisions. But `evalRevision` runs the artifact as-is; docs and comments acknowledge the adapter does not influence deterministic recipe execution yet. `promoteRevision` also sets `headK` equal to the candidate score, so the require-improvement path does not compare the candidate to the previous head.

Existing tests do not protect the capture/distill surface. No `tests/*.test.js` coverage was found for `/v1/capture/openai`, `/v1/capture/anthropic`, `/v1/bridges/observe`, `/v1/bridges/auto-synthesize`, `/v1/labels/synthesize-corpus`, `/v1/specialists/auto-distill`, or `src/tune.js` promotion behavior.

## Pipeline Truth Table

| Surface | What It Does Today | Governance Gap |
| --- | --- | --- |
| Provider capture | Authenticated proxy forwards to OpenAI/Anthropic using `x-upstream-api-key`, then stores prompt, response, status, model, provider, and `corpus_namespace`. | Stores raw data; captures error responses; no retention config; namespace does not match inbox schema. |
| Direct observe | Authenticated route stores model, prompt, response, template hash, variable input, latency, and cost. | No namespace field, no response size cap, and no kept/discarded status at insert time. |
| Capture inbox | Lists tenant observations with excerpts, supports keep/discard, shows ready namespaces. | Uses `namespace`, not `corpus_namespace`; keep/discard is not honored by export or distill. |
| Label export | Returns captured pairs as NDJSON or JSON up to 50,000 rows. | Exports full prompt/response pairs including discarded, unkept, and failed-status captures. |
| Bridge suggestions | Groups observations by template hash at four or more rows and estimates savings. | Proxy captures hash full prompt+model, not template signatures; savings calculation can overstate monthly value. |
| Bridge auto-synthesize | Calls `synthesize` on up to eight examples from a cluster. | Does not create a registry concept/version; lineage id can be undefined. |
| Specialist train | Queues a specialist row with `status: queued`. | No trainer execution or status transition was found; run path falls back to source concept. |
| Auto-distill | Counts namespace captures and forwards a job to an external trainer bridge when configured. | No callback route or artifact/job integration found; unavailable without external bridge. |
| Local tune | Local capture, adapter step, eval, promote, rollback, watch. | Adapter does not affect current eval path; promotion does not compare candidate to previous head. |

## What Is Solid

- Capture, label export, bridge, and auto-distill routes are behind auth; direct public access is not allowed.
- Provider API keys are read from `x-upstream-api-key` and not stored in the observation row.
- `sanitizeNamespace` prevents path-like namespace tokens from reaching storage and route filters.
- Capture inbox returns excerpts, not full prompt/response bodies.
- Label export and auto-distill are tenant-scoped.
- Auto-distill returns explicit 400/503 errors rather than silently pretending the trainer bridge exists.
- Local tune capture is physically local under `~/.kolm/tune/<artifact>/captures.jsonl`.

## Gaps That Need Correction

1. Use one observation schema. `namespace`, `corpus_namespace`, `template_hash`, `status`, `kept`, `discarded`, `source`, and `retention_class` should mean the same thing across capture, inbox, labels, auto-synthesize, and auto-distill.
2. Make triage binding. Discarded rows must be excluded from export, synthesize, and distill. Kept-only mode should be the default for training.
3. Filter failed captures. Rows with non-2xx provider status should not count toward readiness or labels unless explicitly requested.
4. Persist auto-synthesized concepts. Bridge auto-synthesis should create a private concept/version or return `publish: false` explicitly.
5. Implement auto-distill completion. The app needs a callback/status route, specialist row creation, artifact or weights URL population, and receipt linkage before saying it ships a signed artifact.
6. Align retention claims. Either implement per-namespace retention and hash-only expiry, or remove copy that says raw bodies age out to hashes only.
7. Separate local tune from hosted capture. Public pages should make clear which loop is local-only and which loop proxies through hosted capture.
8. Fix tune promotion proof. Candidate eval must include the adapter effect, and require-improvement must compare to the previous head.
9. Add contract tests. Capture failure capture, namespace behavior, discard exclusion, label export, auto-distill threshold, bridge unavailable, and tune promotion need focused tests.

## Release-Blocking Tests

- A proxy capture with `x-kolm-namespace: tickets` must appear in the inbox under `tickets` and must be counted by labels and auto-distill under the same namespace.
- A discarded capture must not appear in label export and must not count toward auto-distill readiness.
- A missing upstream provider key must not produce a training pair by default.
- `/v1/bridges/auto-synthesize` must either create a concept/version or return a clearly non-persistent synthesis result.
- `/v1/specialists/auto-distill` with 1,000 valid kept captures and no bridge must return 503; with a fake bridge it must create trackable local state or explicitly document that the external bridge owns state.
- Capture inbox promote links must land on a page that can load the observation and create a draft.
- `kolm tune promote` must fail require-improvement when candidate and head scores are identical unless forced.
- Public copy and API docs should be snapshot-tested against these route behaviors.

## Decision

Treat capture as an authenticated trace collection preview and local tune as an experimental local adapter loop. Do not position the current hosted capture path as an end-to-end "capture, triage, distill, signed artifact" product until namespace consistency, triage binding, failed-capture filtering, auto-synthesis persistence, bridge completion, retention policy, and tests are in place.
