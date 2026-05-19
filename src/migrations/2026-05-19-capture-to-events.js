// W409a — one-shot migration: backfill the canonical event-store from every
// row currently in the capture-store.
//
// Why this exists
// ----------------
// Before W409a the proxy + connector wrote ONLY to capture-store. The lake /
// opportunity engine / dataset workbench / label queue / training planner all
// read from event-store, so historical traffic was invisible to optimization
// + training. This migration walks every observation row in the legacy
// capture-store (legacy sync store + any pluggable driver) and inserts a
// canonical event with `feedback: 'migrated_from:capture-store-migration'`
// so audit can tell migrated rows apart from live writes.
//
// Idempotency
// -----------
// The event-store insert is `INSERT OR REPLACE INTO events` keyed on
// event_id. Re-running this migration is safe: the second run overwrites the
// same rows with identical content. The provenance tag in the `feedback`
// column lets you find migrated rows with:
//   SELECT event_id, namespace FROM events WHERE json LIKE '%migrated_from:capture-store%';
//
// Usage
// -----
//   node -e "import('./src/migrations/2026-05-19-capture-to-events.js').then(m => m.run().then(console.log))"
//
// Or from a script:
//   import { run } from './src/migrations/2026-05-19-capture-to-events.js';
//   const stats = await run({ dryRun: false });
//   console.log(stats);
//
// Options
// -------
//   dryRun:  do not write to event-store; just count what would migrate
//   limit:   cap on rows scanned (default 100000)
//   verbose: log per-row progress (default false)

import { all as legacyAll } from '../store.js';
import { observationToCanonicalEvent } from '../capture-store.js';
import { appendEvent } from '../event-store.js';

// Try to pull from a pluggable driver (vercel_postgres / vercel_kv) when
// configured. Falls back gracefully if the driver is not installed; the
// legacy synchronous store covers the local-disk case.
async function _drainPluggableDriver() {
  const name = (process.env.KOLM_CAPTURE_DRIVER
    || process.env.KOLM_STORE_DRIVER
    || '').toLowerCase();
  if (name !== 'vercel_postgres' && name !== 'vercel_kv') return [];
  try {
    const mod = await import(name === 'vercel_postgres'
      ? '../store-drivers/vercel-postgres.js'
      : '../store-drivers/vercel-kv.js');
    if (typeof mod.all !== 'function') return [];
    const rows = await mod.all('observations');
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  }
}

function _drainLegacyStore() {
  try {
    const rows = legacyAll('observations');
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  }
}

// run({dryRun, limit, verbose}) -> {scanned, migrated, skipped, failed, errors}
export async function run(opts = {}) {
  const dryRun = !!opts.dryRun;
  const limit = opts.limit == null ? 100000 : Math.max(1, Math.trunc(opts.limit));
  const verbose = !!opts.verbose;

  const legacy = _drainLegacyStore();
  const driver = await _drainPluggableDriver();
  // De-dupe by id (or event_id) — both stores can hold the same row when
  // a deploy switched drivers mid-flight.
  const seen = new Set();
  const all = [];
  for (const r of [...legacy, ...driver]) {
    if (!r) continue;
    const key = String(r.event_id || r.id || JSON.stringify(r).slice(0, 64));
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(r);
    if (all.length >= limit) break;
  }

  const stats = {
    scanned: all.length,
    migrated: 0,
    skipped: 0,
    failed: 0,
    dry_run: dryRun,
    started_at: new Date().toISOString(),
    finished_at: null,
    errors: [],
  };

  for (const row of all) {
    const ev = observationToCanonicalEvent(row, { provenance: 'capture-store-migration' });
    if (!ev) { stats.skipped++; continue; }
    if (dryRun) { stats.migrated++; continue; }
    try {
      await appendEvent(ev);
      stats.migrated++;
      if (verbose) {
        // eslint-disable-next-line no-console
        console.log('[migrate] ' + ev.event_id + ' ns=' + ev.namespace + ' tenant=' + ev.tenant_id);
      }
    } catch (e) {
      stats.failed++;
      if (stats.errors.length < 20) {
        stats.errors.push({ event_id: ev.event_id, error: String(e && e.message || e) });
      }
    }
  }
  stats.finished_at = new Date().toISOString();
  return stats;
}

// Default export for callers that prefer the module-level shape.
export default { run };
