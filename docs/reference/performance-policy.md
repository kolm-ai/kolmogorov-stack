# Performance Policy

Canonical reference for the W890-14 audit. Defines the latency budgets, the
benchmark recipe, the N+1 patterns we forbid, the streaming rules, the
cache-header policy, the model-cache rules, and the memleak-watch runbook.

This document is generated alongside eight `data/w890-14-*.json` artifacts via
`node scripts/w890-14-performance-audit.cjs`. The artifacts are the source of
truth; this file is the human-readable summary.

## 1. Latency targets

| budget                                | target          | measurement                                |
|---------------------------------------|-----------------|--------------------------------------------|
| `/health` round-trip (no auth)        | p95 < 50ms      | local; same middleware chain as every route|
| `/v1/gateway/dispatch` wrapper tax    | p95 < 500ms     | local; includes tier check + PII + route   |
| Cold start (CLI verb dispatch)        | p95 < 500ms     | `node cli/kolm.js whoami` first invocation |
| 100 concurrent `/health` requests     | all complete    | Promise.all of 100 requests                |
| RSS slope under load                  | < 10MB/min      | 5-min window, ~50 req/s steady             |
| /v1/artifacts/:id/download throughput | line-rate       | `createReadStream(path).pipe(res)`         |

The W890-14 spec asks for 1-hour memleak coverage. We run a 5-minute window
by default because a memory leak above 1MB/s would surface in 30 seconds; the
window is configurable via `KOLM_W890_14_MEMLEAK_S=3600` for a full hour run
on the nightly CI lane.

## 2. Benchmark recipe

```bash
# Static audits only (≤2s):
node scripts/w890-14-performance-audit.cjs \
  -- KOLM_W890_14_SKIP_LIVE=1

# Full audit including 5-minute memleak window (≤6min wall):
node scripts/w890-14-performance-audit.cjs

# Full audit including 1-hour memleak window (≤62min wall):
KOLM_W890_14_MEMLEAK_S=3600 node scripts/w890-14-performance-audit.cjs
```

The driver writes eight artifacts under `data/`:

| artifact                                 | shape                                              |
|------------------------------------------|----------------------------------------------------|
| `data/w890-14-gateway-overhead.json`     | `{ mean_ms, p50, p95, p99, sample_size, target_under_500 }` |
| `data/w890-14-n-plus-1.json`             | `{ violations: [], violations_count }`             |
| `data/w890-14-streaming.json`            | `{ endpoints, violations, accepted_exceptions }`   |
| `data/w890-14-model-cache.json`          | `{ loaders, violations }`                          |
| `data/w890-14-prepared-stmts.json`       | `{ sites, prepared_stmt_rate, violations }`        |
| `data/w890-14-cache-headers.json`        | `{ findings, sendfile_without_cache_control }`     |
| `data/w890-14-memleak-smoke.json`        | `{ samples, rss_slope_mb_per_min, slope_within_budget }` |
| `data/w890-14-concurrent-100.json`       | `{ all_completed, errors, p95_ms }`                |

## 3. N+1 patterns we forbid

These shapes are blocked by the W890-14 audit:

```js
// BAD: one query per row.
for (const id of ids) {
  const row = await db.query('SELECT * FROM x WHERE id = $1', [id]);
}

// BAD: same shape, JS array form.
for (const id of ids) {
  const row = await pool.get('SELECT * FROM x WHERE id = ?', id);
}

// BAD: per-iteration upstream fetch.
for (const tenant of tenants) {
  const usage = await fetch(`/v1/usage/${tenant.id}`);
}
```

Canonical replacements:

```js
// GOOD: single batched query with IN(...) clause.
const rows = await db.query(
  'SELECT * FROM x WHERE id = ANY($1)', [ids]
);

// GOOD: SQLite uses dynamic parameter list.
const placeholders = ids.map(() => '?').join(',');
const rows = db.prepare(`SELECT * FROM x WHERE id IN (${placeholders})`).all(...ids);

// GOOD: parallel I/O when batching isn't an option.
const results = await Promise.all(ids.map((id) => fetch(`/v1/usage/${id}`)));
```

The audit does NOT flag synchronous `.find()` / `.filter()` calls over an
in-memory array because the store driver issues exactly one SELECT per
`all(table)` regardless of array length.

The W890-14 lock-in test asserts `violations_count === 0` against
`src/router.js`. See `data/w890-14-n-plus-1.json`.

## 4. Streaming rules

Large file transfers must stream. The audit walks every router endpoint whose
path matches `/download|export|artifact|bundle|.kolm|.zip|attestation/`
and verifies it uses one of:

- `fs.createReadStream(path).pipe(res)` — preferred
- `stream.pipeline(source, res, callback)` — when error-handling is required

Buffered loads (`fs.readFileSync` followed by `res.send(buffer)`) are
forbidden for these routes.

### 4.1 Accepted exceptions

| route                                  | reason                                                                    |
|----------------------------------------|---------------------------------------------------------------------------|
| `/v1/hub/:owner/:name/download`        | size-capped at 25MB at publish time; row stores `artifact_b64` column     |
| `/v1/marketplace/publish` (write side) | accepts base64 in the body (max 4MB enforced by `express.json` limit)     |

These exceptions are listed in `data/w890-14-streaming.json` as
`accepted_exception: true` with an `exception_reason`. New entries require
audit edit + lock-in budget bump.

### 4.2 Streaming endpoints in `src/router.js`

| route                                  | primitive                            |
|----------------------------------------|--------------------------------------|
| `/v1/compile/:id/.kolm`                | `createReadStream(j.artifact_path)`  |
| `/v1/artifacts/:id/download`           | `createReadStream(j.artifact_path)`  |
| `/v1/recipes/:id/download`             | `createReadStream(j.artifact_path)`  |
| `/v1/marketplace/:slug/download`       | `createReadStream(slug_path)`        |

## 5. Cache-header policy

The W890-14 policy maps file class -> cache directive. Every directive is
asserted by the audit; the `setHeaders` block in `server.js` is the canonical
implementation for the `express.static` mount, and every `res.sendFile()`
handler that pre-empts the static mount must set its own `Cache-Control`.

| class                          | directive                                            |
|--------------------------------|------------------------------------------------------|
| HTML (`*.html`)                | `public, max-age=60, must-revalidate`                |
| Hashed JS (`sdk-<sha>.js`)     | `public, max-age=31536000, immutable`                |
| Images, fonts, wasm            | `public, max-age=86400, must-revalidate`             |
| CSS / non-hashed JS / map      | `public, max-age=3600, must-revalidate`              |
| `.well-known/security.txt`     | `public, max-age=3600`                               |
| Spec assets (`/docs/*.json`)   | `public, max-age=300`                                |
| HTML pre-empt routes           | `public, max-age=60, must-revalidate` (per-handler)  |
| 404 fallback / dynamic JSON    | implicit (no `Cache-Control`; default is no-cache)   |

Hashed asset rule: the only assets that get `immutable, max-age=31536000` are
ones whose filename contains a content hash (the regex
`/sdk-[a-f0-9]{8,}\.js$/`). Any new long-cache asset MUST embed a content
hash in the filename so a new deploy invalidates the cache atomically.

See `data/w890-14-cache-headers.json`.

## 6. Model-cache rules

Module-scope cache is required for every loader symbol whose name matches:

- `loadModel`
- `loadCheckpoint`
- `loadEmbedder`
- `loadTokenizer`
- `loadAdapter`
- `loadTensor`

Cache evidence: a module-level binding ending in
`Cache | Cached | Loaded | Memo | Memoized | Pool | Registry`, or a
`let _foo = null;` sentinel, or a `new Map()` / `new WeakMap()` at the top of
the file. Caches must be created at module scope so calls from request
handlers do not allocate a fresh cache per request.

The audit covers `src/**/*.js` and reports `loaders_count` and
`violations_count`. See `data/w890-14-model-cache.json`.

## 7. Prepared-statement rules

All SQLite reads and writes go through `db.prepare(sql).run|get|all|iterate`
with `?` placeholders. The exception list is narrow:

- `db.exec('PRAGMA ...')` — DDL / runtime config
- `db.exec('CREATE TABLE / CREATE INDEX / ALTER TABLE ...')` — schema set-up
- `db.exec('BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE')` — txn control

All Postgres reads and writes go through `pool.query(sql, vals)` with
`$1`-style placeholders. String concatenation (`pool.query('... ' + id)`)
is forbidden and flagged by the audit.

See `data/w890-14-prepared-stmts.json`. The aggregate
`prepared_stmt_rate` must equal `1.0`.

## 8. Memleak-watch runbook

Symptom: server RSS grows monotonically under steady load.

1. Reproduce locally:
   ```bash
   KOLM_W890_14_MEMLEAK_S=3600 node scripts/w890-14-performance-audit.cjs
   ```
   Inspect `data/w890-14-memleak-smoke.json` -> `rss_slope_mb_per_min`.
2. If the slope is > 10MB/min, pull the latest heap snapshot:
   ```bash
   NODE_OPTIONS=--inspect node server.js &
   # open chrome://inspect, take a heap snapshot before + after 5min load
   ```
3. Common offenders:
   - Unbounded `EventEmitter` listener accumulation (set `maxListeners(0)` or
     remove explicitly)
   - Per-request `setTimeout` without `.unref()` keeping the event loop hot
   - Capture log writes appending to an in-memory buffer instead of flushing
     to disk
4. The W890-14 audit's `slope_within_budget === true` invariant gates
   release; a regression here means the most recent deploy introduced
   the leak.

## 9. Concurrent-request handling

`/v1/gateway/dispatch` is the hot path; it must accept 100 simultaneous
requests without crashing or timing out. The W890-14 audit fires 100
parallel GETs against `/health` (no auth, same middleware chain) and asserts:

- `all_completed === true`
- `errors === 0`
- `p95_ms < 5000`

`/health` is used instead of `/v1/gateway/dispatch` for the concurrency
probe because the gateway path requires an upstream provider that the audit
does not configure. The middleware chain is identical (`helmet`, `compression`,
`cookieParser`, `express.json`, router lookup) so the result is a true
measurement of the server's concurrency floor.

## 10. Gateway overhead measurement

The W890-14 audit fires 50 `/v1/gateway/dispatch` calls plus 50 `/health`
calls, computes p50/p95/p99 for each, and reports:

- `mean_ms`, `p50`, `p95`, `p99` for dispatch
- `overhead_ms_p95 = max(0, dispatch_p95 - health_p95)` — wrapper isolated

The wrapper tax in test mode (no upstream) is measured at p95 < 500ms. In
production, the dispatch p95 includes the upstream round trip and is
documented separately in `bench/wave888-wrapper-tax-decomposed.json`. The
W890-14 lock-in asserts `target_under_500 === true` against the local
wrapper tax measurement.

## 11. Database connection pooling

| backend  | pool                                  | settings                                |
|----------|---------------------------------------|-----------------------------------------|
| SQLite   | none (single-process via `node:sqlite`) | WAL mode + busy_timeout=30000          |
| Postgres | `pg.Pool`                             | `max: 10`, `idleTimeoutMillis: 30000`   |

The W890-8 audit ratifies these; the W890-14 audit references them for the
concurrent-request guarantee. Single-process SQLite means contention is
bounded by `busy_timeout`; Postgres throughput is bounded by `max=10`
in-flight queries.

## 12. Ship-gate

The W890-14 audit emits a structural snapshot of
`scripts/ship-gate.cjs` to `data/w890-14-ship-gate-snapshot.json`. The
lock-in test invokes ship-gate itself for the 52/52 invariant.

| condition                              | status              |
|----------------------------------------|---------------------|
| ship-gate CHECKS array length          | 52                  |
| ship-gate `--json` passed              | 52 (asserted live)  |
