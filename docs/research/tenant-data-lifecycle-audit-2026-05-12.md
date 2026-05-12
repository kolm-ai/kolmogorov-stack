# Tenant Data Lifecycle Audit

Date: 2026-05-12

Scope: local review of tenant-scoped storage, registry/runtime access, compile jobs and artifacts, recall source access, capture/bridge observations, cache behavior, account cancellation/deletion, and related tests.

## Executive Findings

1. P1: account deletion is a soft tenant delete, not data deletion. A local smoke proved that after `/v1/account/delete`, the old key no longer works but both public and private concepts remain in storage, and the public concept remains readable.
2. P1: recall source preview has a path-prefix escape. `GET /v1/recall/sources/:id(*)` checks `full.startsWith(lookupRoot)` rather than a path-boundary-aware test; a sibling tenant directory with the same prefix can pass.
3. P1: L2 runtime cache writes to `data/cache` instead of `KOLM_DATA_DIR`, so cached outputs can live outside the configured storage and deletion lifecycle.
4. P1/P2: some lineage and specialist-candidate aggregate counts are concept-scoped but not tenant-filtered. Public/shared concepts can expose cross-tenant usage aggregates.
5. P1: capture proxy and bridge observations store prompts/responses without visible retention, redaction, export, or delete controls.

## What Looks Solid

Registry reads use `canRead`: public concepts are readable by anyone, and private concepts require matching tenant. Runtime execution goes through `getVersion` or `getHead`, so private runtime access inherits that boundary.

Compile jobs are created with `tenant: req.tenant`; list/status/download routes use `getJob(id, req.is_admin ? null : req.tenant)`. Status responses strip `artifact_path` and `deploy_hook`, returning only `deploy_hook_set`.

Observation inbox routes are mostly tenant-scoped: suggestions, lists, updates, auto-synthesis, and labels export filter `observations` by `o.tenant === req.tenant`.

`/v1/public/submit` is authenticated and checks ownership before creating a submission, despite the `/public` name.

## Delete Does Not Mean Purge

`POST /v1/account/delete` updates the tenant row:

```text
_deleted: true
deleted_at: now
billing_status: cancelled
pending_plan: null
```

It clears the session cookie but does not remove tenant data from:

- `concepts`
- `versions`
- `observations`
- `invocations`
- `compile_jobs`
- artifact zip files
- runtime cache files
- submissions
- waitlist rows

Local smoke result:

```json
{
  "deleteStatus": 200,
  "deleteOk": true,
  "authAfter": false,
  "conceptsAfter": [
    { "visibility": "public" },
    { "visibility": "private" }
  ],
  "publicConceptStillReadable": 200
}
```

This may be acceptable only if the product calls it deactivation and publishes a retention policy. If it remains "delete", it needs a deletion workflow that purges or anonymizes private records, public records, artifacts, and caches according to a documented retention model.

## Recall Source Escape

Recall ingest has a stronger path guard:

```text
resolved === tenantRoot || resolved.startsWith(tenantRoot + path.sep)
```

Recall source preview uses only:

```text
full.startsWith(lookupRoot)
```

Local path smoke:

```json
{
  "tenantRoot": "C:\\tmp\\recall-root\\tenant",
  "sibling": "C:\\tmp\\recall-root\\tenant2\\secret.md",
  "currentCheckPasses": true,
  "safeCheckPasses": false
}
```

Use a shared helper based on `path.relative` or exact-plus-separator checks. Add tests for `..`, sibling prefixes, encoded separators, and Windows/POSIX path behavior.

## Cache Lifecycle Gap

`src/cache.js` writes disk cache to `path.resolve('data','cache')` except on serverless. It does not honor `KOLM_DATA_DIR`, even though storage readiness and production configuration revolve around `KOLM_DATA_DIR`.

This matters because runtime outputs may contain sensitive data derived from inputs. A tenant can delete their account while cached outputs remain outside the configured data directory. At minimum:

- cache root should live under `KOLM_DATA_DIR` or `KOLM_CACHE_DIR`,
- cache retention should be explicit,
- account deletion should invalidate tenant-owned cache entries,
- cache keys should include tenant or trust mode when runs are not safe to share.

## Aggregate Leakage

Two routes aggregate by concept id without tenant filtering after authorizing access to the concept:

- `/v1/recipes/:id/lineage` counts observations, specialists, invocations, and corpus jobs by concept/recipe id.
- `/v1/bridges/specialist-candidates` filters concepts to owner/admin, then counts all invocations for each concept id.

For private concepts this is usually bounded by ownership. For public concepts, any tenant can run the same concept id, and the owner or another public reader can see aggregate usage counts or model sets that may include other tenants' activity. Decide whether these are product analytics or tenant-private dashboard data; implement and label accordingly.

## Capture Data Needs A Retention Model

The capture proxy avoids persisting upstream provider API keys, which is good. But it stores prompt and response payloads into `observations`, with prompt slices up to 8000 chars and response slices up to 16000 chars. Those captures become labels and distillation data.

Before positioning capture as a governed enterprise feature, Kolm needs:

- namespace-level retention settings,
- redaction before persistence,
- export and delete controls,
- DPA/subprocessor wording tied to actual behavior,
- tests proving cross-tenant capture isolation.

## Immediate Backlog

1. Fix recall source preview path validation.
2. Decide whether account deletion is deactivation or purge; implement the chosen semantics.
3. Move cache root under configured data/cache storage and include it in deletion/retention.
4. Filter or label cross-tenant public aggregate telemetry.
5. Add `tenant-isolation.test.js` for private/public reads, runs, delete retention, recall source traversal, cache root, public submit ownership, and lineage aggregate scoping.

See `tenant-data-isolation-matrix-2026-05-12.csv` for row-level evidence and recommended actions.
