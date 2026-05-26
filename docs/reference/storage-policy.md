# Storage Policy

Canonical reference for the W890-8 audit. Consolidates the SQLite schema +
index plan, the Postgres connection-pool configuration, the S3 IAM template,
and the backup / retention / purge story.

This document is generated alongside seven `data/w890-8-*.json` artifacts via
`node scripts/w890-8-storage-audit.cjs`. The artifacts are the source of
truth; this file is the human-readable summary.

## 1. SQLite schemas and indexes

kolm ships three SQLite-flavored tables:

| table              | source                          | role                              |
|--------------------|---------------------------------|-----------------------------------|
| `events`           | `src/event-store.js`            | canonical telemetry plane (W409a) |
| `kolm_store_rows`  | `src/store.js`                  | generic row store (JSON column)   |
| `captures` (PG)    | `src/storage/postgres-store.js` | optional Postgres backend         |

### 1.1 `events` (canonical capture lake)

Every capture flows through `capture-store.insertCapture()` and is bridged
into the `events` table (`appendEvent()` in `src/event-store.js`). The bridge
is idempotent (`INSERT OR REPLACE INTO events` keyed on `event_id`) and
queries the W890-8 spec cares about (namespace / status / timestamp /
capture id) are covered by:

| W890-8 token   | canonical column | index                       |
|----------------|------------------|-----------------------------|
| `namespace_id` | `namespace`      | `idx_events_ns_ts`          |
| `status`       | `status`         | `idx_events_status`         |
| `timestamp`    | `created_at`     | `idx_events_ns_ts`          |
| `capture_id`   | `event_id`       | `PRIMARY KEY (event_id)`    |

Additional indexes cover the optimization / analytics query patterns:
`idx_events_tenant_ts`, `idx_events_request_hash`, `idx_events_workflow`,
`idx_events_provider_model`, `idx_events_media_kind`, `idx_events_media_hash`.

### 1.2 `kolm_store_rows` (generic JSON row store)

Used by `observations`, `staged_captures`, and several tenant-keyed tables.
Indexed by `(table_name, row_id)`; per-field lookups use the SQLite JSON1
extension via `findByField(table, field, value)` which issues
`WHERE json_extract(json, '$.<field>') = ?`.

### 1.3 `captures` (Postgres backend, optional)

Used when the operator sets `KOLM_CAPTURE_POSTGRES_URL`. Schema includes
`namespace`, `tenant_id`, `created_at`, and `chain_hash` indexes
(`idx_captures_namespace`, `idx_captures_tenant`, `idx_captures_created`,
`idx_captures_chain_hash`).

See `data/w890-8-sqlite-indexes.json` for the full extracted shape.

## 2. WAL mode

Both SQLite-backed modules issue `PRAGMA journal_mode = WAL` on open:

- `src/store.js` line 227 (synchronous = FULL)
- `src/event-store.js` line 80 (synchronous = NORMAL)

WAL allows concurrent readers without blocking the writer. The audit
artifact is `data/w890-8-wal-mode.json`.

## 3. Migrations

kolm does **not** use a file-versioned migration tool (no Knex/Flyway).
The schema evolves via three idempotent mechanisms:

1. **`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`** — every
   schema declaration is wrapped so a fresh boot reaches the same final
   shape as an existing instance.
2. **`PRAGMA table_info` + additive `ALTER TABLE`** — `src/event-store.js`
   reads the current column set and only adds what is missing (W377 media_*
   columns). Crash-safe and re-runnable.
3. **Data-backfill scripts** — `src/migrations/2026-05-19-capture-to-events.js`
   walks the legacy capture-store and seeds the canonical event-store.
   Idempotent (the canonical store deduplicates by `event_id`).

Postgres: `migrate()` in `PostgresCaptureStore` runs the same idempotent
`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` SQL.

Drift is not detected; every supported boot path converges on the same
final schema.

See `data/w890-8-migrations.json`.

## 4. Backup strategy

Three layers are documented:

1. **`pg_dump` / `psql`** — `docs/self-hosted-deploy-complete.md` §6
   documents the canonical Postgres backup loop:
   ```bash
   pg_dump -Fc kolm > /backup/kolm-$(date +%F).dump
   ```
2. **`tar` + `gpg`** — same doc shows the data-dir archive:
   ```bash
   tar -czf /backup/kolm-data-$(date +%F).tar.gz $KOLM_DATA_DIR
   gpg --symmetric --cipher-algo AES256 /backup/kolm-data-$(date +%F).tar.gz
   ```
3. **JSON `.bak` siblings** — `src/store.js` writes a sibling `.bak` for
   every JSON table flush so a corrupt primary can be recovered without
   external tooling (line 211).

For SQLite specifically, the simplest backup is `cp captures.db
captures.db.bak` while the writer is idle (or use SQLite's `VACUUM INTO` /
`.backup` for an online consistent copy).

See `data/w890-8-backup-strategy.json`.

## 5. Retention and purge

| layer            | default            | configurable via                              |
|------------------|--------------------|-----------------------------------------------|
| free tier        | 90 days            | per-namespace policy (gateway.toml)           |
| audit log        | 365 days (SOC 2)   | `KOLM_AUDIT_RETENTION_DAYS`                   |
| lake retention   | unset (no purge)   | `kolm lake retention set --days N`            |

### 5.1 Verbs

```bash
# Local event-store lake purge (dry-run by default; --yes to commit):
kolm lake purge --older-than 90 --json
kolm lake retention set --days 365
kolm lake retention apply --yes

# Remote per-id or namespace-bulk forget (hits /v1/captures/forget):
kolm captures purge --capture-id cap_abc123 --reason gdpr_erasure
kolm captures purge --namespace dev-sandbox --confirm
```

### 5.2 Limits

- `MIN_RETENTION_DAYS = 90`  (SOC 2 Type I floor — `setRetentionDays` rejects below.)
- `DEFAULT_RETENTION_DAYS = 365`  (SOC 2 Type II evidence window.)
- `MAX_RETENTION_DAYS = 2555`  (~7y; HIPAA + GDPR ceiling.)

### 5.3 Constraints

- `enforceRetentionPolicy()` defaults to `dry_run: true` and **rejects**
  `confirm:true` without `dry_run:false` — destruction must be opt-in via
  both flags.
- Every purge path is tenant-fenced; rows are re-filtered by `tenant_id`
  inside the helper even when the caller already passed the filter.

See `data/w890-8-retention.json`.

## 6. Postgres connection pool

The optional `PostgresCaptureStore` uses `pg.Pool`:

```js
new pg.Pool({
  connectionString: KOLM_CAPTURE_POSTGRES_URL,
  max: 10,                    // up to 10 concurrent connections
  idleTimeoutMillis: 30000,   // idle connection eviction
});
```

`pg` is lazy-imported so the base install does not pull it in. The pool
is opened once per `PostgresCaptureStore` instance — no new connection per
request. The caller owns the lifecycle; call `store.close()` on shutdown.

`statement_timeout` is configured server-side or via the connection-string
query parameter (`?options=-c%20statement_timeout=10s`), not at pool init.

See `data/w890-8-postgres-pool.json`.

## 7. S3 IAM

kolm's S3-compatible storage layer issues exactly the action set declared
in `src/object-storage.js`:

| kolm capability | IAM action            |
|-----------------|-----------------------|
| `put`           | `s3:PutObject`        |
| `get`           | `s3:GetObject`        |
| `head`          | `s3:GetObject`        |
| `delete`        | `s3:DeleteObject`     |
| `list`          | `s3:ListBucket`       |
| `list-buckets`  | `s3:ListAllMyBuckets` |

`s3:*` is **never** issued. The least-privilege policy template scoped to
the configured bucket is:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "KolmReadWriteBucket",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::${KOLM_S3_BUCKET}/*"
    },
    {
      "Sid": "KolmListBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${KOLM_S3_BUCKET}"
    }
  ]
}
```

The `list-buckets` (`s3:ListAllMyBuckets`) action is only required for the
operator-facing bucket discovery surface and should be omitted from
runtime IAM grants.

See `data/w890-8-s3-iam.json`.

## 8. Audit artifacts (machine-readable)

| artifact                                | covers                          |
|-----------------------------------------|---------------------------------|
| `data/w890-8-sqlite-indexes.json`       | schema + index coverage         |
| `data/w890-8-migrations.json`           | migration scheme + drift        |
| `data/w890-8-backup-strategy.json`      | backup mechanisms documented    |
| `data/w890-8-retention.json`            | retention policy + purge smoke  |
| `data/w890-8-wal-mode.json`             | WAL pragma presence             |
| `data/w890-8-postgres-pool.json`        | pool configuration              |
| `data/w890-8-s3-iam.json`               | IAM action scope                |

Run `node scripts/w890-8-storage-audit.cjs` to refresh every artifact. The
script is read-only — it never opens a live DB or mutates SQLite files.

## 9. Limitations

- The audit is repo-driven; it asserts the source files declare the
  expected schema / pragmas, not that a running deployment has applied
  them. Live verification requires opening the DB on the target host.
- Postgres `statement_timeout` is not enforced at pool init; operators
  must wire it server-side or via the connection string.
- Free-tier retention default (90 days) is named here for the W890-8 spec
  alignment; the actual per-namespace policy lives in `gateway.toml`.
