# Data durability: datastore choice + backup/restore runbook

This document covers two things:

1. **Why SQLite-on-a-persistent-volume is the correct production datastore** for
   the kolm Agent Security-Review backend today, and the explicit trigger that
   would move us to Postgres.
2. **The backup/restore runbook** — how snapshots are taken automatically, and
   the exact steps to restore one on Railway.

---

## 1. Datastore assessment: SQLite-on-volume vs Postgres

### What the data layer actually is

The core transactional store is `src/store.js`. It is **fully synchronous**:

- The SQLite driver uses `node:sqlite` (`DatabaseSync`) — every `insert` /
  `update` / `find` / `findByField` / `remove` and the `withTransaction`
  wrapper (`BEGIN IMMEDIATE` / `COMMIT`, re-entrant via `SAVEPOINT`) run
  synchronously and return values directly, not Promises.
- The JSON driver writes table files synchronously with `fsync` + atomic
  rename + `.bak` mirroring.

The **entire codebase calls the store synchronously** — hundreds of call sites
across `src/router.js`, `src/auth.js`, `src/asr-fulfillment.js`, billing,
entitlements, the Stripe webhook, and the Continuous re-attestation sweep all do
`const rows = find(...)` / `withTransaction(() => { insert(...); update(...) })`
inline, with no `await`.

In production (`RAILWAY_ENVIRONMENT` / `NODE_ENV=production`) the store defaults
to the SQLite driver on the persistent volume at `KOLM_DATA_DIR`, with:

- `PRAGMA journal_mode = WAL` (concurrent reads during writes),
- `PRAGMA synchronous = FULL` (durable through power loss / container kill),
- `PRAGMA busy_timeout = 30000`,
- expression indexes on the hot `json_extract(...)` lookups (tenant fence, slug,
  Stripe subscription id), and
- a **hard fail-closed guard at boot** (`src/store.js`) that refuses to start in
  a production-like environment if `KOLM_DATA_DIR` is not writable, rather than
  silently degrading onto ephemeral `/tmp` and losing paid + audit state on the
  next restart.

### Why NOT Postgres for this store (today)

A Postgres driver for `src/store.js` is **the wrong move at the current scale and
architecture**, for one decisive reason: the node-postgres (`pg`) API is
**async-only**. There is no synchronous query path. Adopting it for the core
store would force one of:

- **Async-rewrite the entire data layer and every call site.** Every `insert` /
  `update` / `find` / `withTransaction` becomes `async`, and every one of the
  hundreds of synchronous callers across routing, auth, billing, entitlements,
  webhooks, and the re-attestation scheduler must be converted to `await` and
  re-audited for new interleaving / partial-write hazards. `withTransaction`'s
  synchronous re-entrancy contract (it explicitly throws if `fn` returns a
  thenable) would have to be redesigned. This is a large, destabilizing change
  that trades a working, durable system for transaction-boundary and
  race-condition risk — with **no benefit at single-instance scale**.

- **Run a synchronous shim over Postgres** (e.g. blocking the event loop on a
  network round-trip). That is strictly worse than local SQLite: it adds network
  latency and a new failure mode to every single store call while keeping all the
  downsides.

SQLite-on-a-persistent-volume is not a compromise here — for a **single
long-lived web instance** (which is exactly how this backend runs on Railway) it
is the *better* engineering choice: in-process, zero network latency,
ACID/WAL-durable, with real transactions and indexes, and no second managed
service to operate, secure, and pay for.

### `pg` is already a dependency — for the part of the system that needs it

`pg` is in `package.json` and is **already wired**, but deliberately **only on
the async, opt-in capture path**, never on the core synchronous store:

- `src/store-drivers/vercel-postgres.js` and `src/storage/postgres-store.js` are
  optional, **lazy-imported, fully-async** backends for the high-volume,
  append-only **capture** pipeline (agent-log ingestion). They activate only when
  an operator sets `KOLM_STORE_DRIVER=vercel_postgres` /
  `KOLM_CAPTURE_POSTGRES_URL`; with those unset, `pg` is never touched.

> **`KOLM_STORE_DRIVER` is a shared env var across two namespaces.** Values
> `json` / `sqlite` steer the **core synchronous row store** (`src/store.js`);
> values `vercel_postgres` / `vercel_kv` steer the **pluggable async capture
> driver** (`src/capture-store.js`). Setting it to `vercel_postgres` /
> `vercel_kv` does NOT crash the core store: `src/store.js` treats those as "not
> a core-store driver", logs a one-line notice, and keeps the core store on its
> detected `json`/`sqlite` driver. Only a genuinely unknown string is a hard
> boot error. Teams seat-billing transactionality (`withTransaction` =
> `BEGIN IMMEDIATE`) is **sqlite-only**; a production teams-enabled deploy is
> asserted onto sqlite at boot (`assertTeamsTransactionality()`), overridable
> only with `KOLM_ALLOW_NONTXN_TEAMS=true`.

That capture path is **already async by design**, so Postgres fits it naturally —
and it is precisely the surface that would scale horizontally first (many writers,
huge append volume). The core transactional store (tenants, API keys,
`agent_audits`, subscriptions, billing) is low-volume, single-writer, and
latency-sensitive — the opposite profile.

> (Note: the `ssh2` device tunnel in `src/device-ssh.js` uses `ssh2.Client`, not
> `pg`. The only `pg` consumers are the optional capture backends above.)

### The trigger to migrate the core store to Postgres

Migrate the **core transactional store** to Postgres when — and only when — we
need to **scale the web tier horizontally to more than one concurrent writer
instance**, i.e. any of:

- We run **2+ Railway/Node web replicas** that all need to read-write the same
  tenant/billing/audit state (multi-writer ⇒ a single local SQLite file no
  longer works; WAL is single-host only).
- We adopt **blue/green or rolling deploys with overlapping live instances** that
  both serve write traffic against shared state.
- Write throughput or dataset size outgrows a single host's local disk/IO.

At that point the correct sequence is: (1) introduce an async store interface,
(2) port the call sites behind it deliberately (the capture path already proves
the async Postgres shape), (3) cut over with a backfill + dual-write window. Until
that horizontal-scaling trigger fires, SQLite-on-volume + the automated backups
below is the right, durable answer.

### So what was the real durability gap?

Not the database engine — the **lack of backups**. A persistent volume survives
container restarts and deploys, but does **not** protect against:

- logical corruption or a bad migration,
- an accidental `reset` / destructive write,
- volume-level loss (provider incident, mis-mount, accidental volume delete).

`src/store-backup.js` closes that gap with consistent, restorable, point-in-time
snapshots, scheduled in-process and on graceful shutdown.

---

## 2. Backup/restore runbook

### How backups are taken

Wiring lives in `server.js`; the implementation is `src/store-backup.js`.

- **Scheduled:** an unref'd `setInterval` calls `backupNow()` every
  `KOLM_BACKUP_INTERVAL_H` hours (default **6**), then `pruneBackups()` retains
  the most recent **14** snapshots. An initial snapshot is kicked ~2 minutes
  after boot so a fresh deploy has a recovery point without waiting a full
  interval.
- **On shutdown:** the `SIGTERM` / `SIGINT` graceful-shutdown handler runs one
  best-effort `backupNow()` **before** draining connections, so every deploy /
  rolling restart leaves behind a fresh, consistent snapshot.
- **Disable:** set `KOLM_BACKUP_DISABLE=1`.

**SQLite snapshots** use `VACUUM INTO`, which produces a fully consistent,
self-contained copy of the live database **online** — no writer downtime, and it
reads through the WAL so all committed rows are captured. The snapshot is a
single, immediately-openable `.sqlite` file.

**JSON snapshots** (non-production / `KOLM_STORE_DRIVER=json`) copy the top-level
`*.json` table files into a timestamped directory.

Snapshots are written under `KOLM_DATA_DIR/backups/`:

```
$KOLM_DATA_DIR/backups/kolm-2026-06-09T12-34-56-789Z.sqlite        # sqlite driver
$KOLM_DATA_DIR/backups/kolm-2026-06-09T12-34-56-789Z-vault/        # encrypted secrets-vault sidecar (sqlite driver)
$KOLM_DATA_DIR/backups/kolm-2026-06-09T12-34-56-789Z/              # json driver (dir of *.json + secrets/ sidecar)
```

### The encrypted secrets vault is snapshotted in every driver mode

`src/secrets-vault.js` holds tenant RunPod/provider API keys **encrypted at
rest** (`secrets-vault.json`) under an AES-256-GCM key in `secrets-vault.key`.
`backupNow()` snapshots BOTH as first-class artifacts in every driver mode:

- **SQLite driver:** a `kolm-<ts>-vault/` sidecar dir next to the `.sqlite`
  snapshot containing `secrets-vault.json`, `secrets-vault.json.bak`, and
  `secrets-vault.key`.
- **JSON driver:** a `secrets/` sidecar inside the timestamped snapshot dir with
  the same three files (the `.key` is **not** captured by the `*.json` table
  copy, so backing it up here is what makes the ciphertext recoverable).

The key copy is gated by `KOLM_BACKUP_INCLUDE_VAULT_KEY` (default on). Set it to
`0` to EXCLUDE the raw key from co-located snapshots when you follow the off-box
encryption guidance below (encrypt the key separately, store it apart from the
ciphertext). `listBackups()` lists vault sidecars with `kind: 'vault'` and a
`vault_files` array.

**Restoring the vault:** copy `secrets-vault.json`, `secrets-vault.json.bak`,
and `secrets-vault.key` from the sidecar back into `$KOLM_DATA_DIR` (or `~/.kolm`
when `KOLM_DATA_DIR` is unset), preserving `0o600` permissions:

```bash
cp "$KOLM_DATA_DIR/backups/<snapshot>-vault/secrets-vault.json"     "$KOLM_DATA_DIR/"
cp "$KOLM_DATA_DIR/backups/<snapshot>-vault/secrets-vault.json.bak" "$KOLM_DATA_DIR/"
cp "$KOLM_DATA_DIR/backups/<snapshot>-vault/secrets-vault.key"      "$KOLM_DATA_DIR/"
chmod 600 "$KOLM_DATA_DIR/secrets-vault."* "$KOLM_DATA_DIR/secrets-vault.key"
```

Without the `.key`, the ciphertext is unrecoverable - which is exactly why the
key is captured alongside it (and why you should encrypt the off-box copy).

Because backups live **on the same persistent volume** as the live DB, they
protect against logical corruption / accidental writes / bad deploys. They do
**not**, by themselves, protect against total loss of the volume — for that,
periodically copy a snapshot **off-box** (see "Off-box copies" below).

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `KOLM_BACKUP_INTERVAL_H` | `6` | Hours between scheduled snapshots (min 1). |
| `KOLM_BACKUP_DISABLE` | unset | Set to `1` to disable scheduled + shutdown backups. |
| `KOLM_DATA_DIR` | volume mount | Backups go to `<KOLM_DATA_DIR>/backups/`. |
| `KOLM_DB_PATH` | `<KOLM_DATA_DIR>/kolm.sqlite` | Source DB for SQLite snapshots. |

### Inspecting backups on Railway

```bash
# Open a shell on the running service (Railway dashboard → service → Shell,
# or `railway run bash`), then:
ls -la "$KOLM_DATA_DIR/backups"

# Verify a snapshot is a valid SQLite DB and has rows:
node -e "const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(process.argv[1]);
  console.log(db.prepare('SELECT table_name, COUNT(*) n FROM kolm_store_rows GROUP BY table_name').all());
  db.close();" "$KOLM_DATA_DIR/backups/<snapshot>.sqlite"
```

### Restoring a SQLite snapshot on Railway

A restore is a file swap. **The live DB must be quiescent** during the swap, so
stop write traffic first.

1. **Pick the snapshot** to restore from `ls -la "$KOLM_DATA_DIR/backups"`.
   Verify it (command above) before proceeding.

2. **Stop the writer.** Either scale the service to 0 replicas, or set
   `KOLM_BACKUP_DISABLE=1` and stop the process — the goal is that nothing is
   writing to `$KOLM_DB_PATH` while you swap files. (Restarting into a restored
   DB while the old process still holds the file open will corrupt the swap.)

3. **Preserve the current state** (so a bad restore is itself reversible):

   ```bash
   ts=$(date -u +%Y%m%dT%H%M%SZ)
   mv "$KOLM_DB_PATH"        "$KOLM_DB_PATH.pre-restore-$ts"     2>/dev/null || true
   # WAL/SHM sidecars MUST be removed/moved or they will be replayed on top of
   # the restored file and undo the restore. NOTE: a graceful shutdown now runs
   # `PRAGMA wal_checkpoint(TRUNCATE)` (src/store.js close() + a SIGTERM/exit
   # hook), so a cleanly-stopped instance leaves these sidecars empty or absent.
   # Move them anyway - a hard-killed (SIGKILL / OOM) process can still leave a
   # non-empty WAL:
   mv "$KOLM_DB_PATH-wal"    "$KOLM_DB_PATH-wal.pre-restore-$ts" 2>/dev/null || true
   mv "$KOLM_DB_PATH-shm"    "$KOLM_DB_PATH-shm.pre-restore-$ts" 2>/dev/null || true
   ```

4. **Put the snapshot in place.** The snapshot is self-contained (VACUUM INTO has
   no WAL sidecar), so a plain copy is the whole restore:

   ```bash
   cp "$KOLM_DATA_DIR/backups/<snapshot>.sqlite" "$KOLM_DB_PATH"
   ```

5. **Restart / scale the service back up.** On boot the store opens
   `$KOLM_DB_PATH`, re-enables WAL, and serves the restored data. Confirm via
   `/health` and a spot check (e.g. a known `agent_audits` row / tenant).

6. **Clean up** the `*.pre-restore-*` files once the restore is confirmed good.

### Restoring a JSON snapshot (non-production)

Stop the process, then copy the snapshot's `*.json` files back over
`$KOLM_DATA_DIR`:

```bash
cp "$KOLM_DATA_DIR/backups/<snapshot-dir>/"*.json "$KOLM_DATA_DIR/"
```

Restart. (The store also keeps `*.json.bak` mirrors and quarantines corrupt
files as `*.corrupt-*` for finer-grained recovery — see `src/store.js`.)

### SQLite self-recovery (fail-soft parity with the JSON driver)

The SQLite driver now matches the JSON driver's resilience. On open,
`src/store.js` runs `PRAGMA integrity_check`; if `kolm.sqlite` fails to open or
fails the integrity check, it **quarantines** the corrupt file (and its
`-wal`/`-shm` sidecars) to `kolm.sqlite.corrupt-<ts>`, **restores the newest
`backups/kolm-*.sqlite` snapshot** if one exists, and re-opens — logging loudly
at each step. If no snapshot is present it starts a fresh empty DB and re-imports
any `*.json` seed tables. This means a corrupt production DB degrades softly
instead of throwing at the first query.

### One-shot migrations

Historical capture traffic is backfilled into the canonical event-store by the
`2026-05-19-capture-to-events` migration. It is registered in
`src/migrations/index.js` with an idempotency ledger (`kolm_migrations` store
table). Run pending migrations explicitly:

```bash
kolm migrate            # apply pending migrations (records each in the ledger)
kolm migrate --dry-run  # show what WOULD migrate without writing
kolm migrate --status   # list registered migrations + applied state
```

The runner skips already-applied migrations (ledger lookup), and the underlying
event-store insert is `INSERT OR REPLACE` so a re-run is safe even if the ledger
is lost. Only `src/migrations/*` is canonical; any copy under `tmp/` is a
launch-time artifact and is never in the runner's import path.

### Off-box copies (protect against volume loss)

The automated snapshots live on the same volume as the DB, so add an off-box copy
for disaster recovery. Pull a recent snapshot to durable external storage on a
schedule (CI cron, a tiny worker, or manually before risky deploys):

```bash
# From an operator machine with `railway` access:
railway run bash -c 'cat "$KOLM_DATA_DIR/backups/$(ls -1 "$KOLM_DATA_DIR/backups" | tail -1)"' \
  > "kolm-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
# then upload to S3/GCS/B2/etc.
```

To restore from an off-box copy, upload it back onto the volume (or into
`$KOLM_DATA_DIR/backups/`) and follow the SQLite restore steps above.

---

## Tests

`tests/store-backup.test.js` covers:

- SQLite: `backupNow()` writes a `VACUUM INTO` snapshot; opening it as an
  independent DB returns the inserted rows (the restorability assertion).
- JSON: `backupNow()` copies the `*.json` table files into a timestamped dir and
  skips non-`.json` / `.bak` siblings.
- Retention: `pruneBackups(keep)` retains the newest N (explicit and default 14),
  and is a no-op below threshold.
- Boundary: `backupNow()` / `listBackups()` never throw and return structured
  results for an unresolvable target.

Run:

```bash
node --test tests/store-backup.test.js
```
