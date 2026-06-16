// Atom7 - first-class migration runner + idempotency ledger.
//
// Before this, the one-shot capture-to-events backfill
// (2026-05-19-capture-to-events.js) had NO invocation path: an operator had to
// paste a `node -e` snippet, with no ledger entry, no dry-run surfaced in any
// tool, and no record that it ran. This module fixes that:
//
//   - MIGRATIONS: the canonical, ordered registry. Each entry is sourced ONLY
//     from src/migrations/* - the stray tmp/ launch-artifact copy is never in
//     any import path here, so it can never silently diverge from canonical.
//   - kolm_migrations store table: the idempotency ledger (migration id +
//     applied_at + stats). runPendingMigrations() skips already-applied
//     migrations and records each successful apply.
//   - dryRun support flows through the runner so `kolm migrate --dry-run` (CLI,
//     integration lane) can show what WOULD migrate without writing.
//
// The underlying run() is already INSERT-OR-REPLACE idempotent on the
// event-store side, so a re-run is safe even if the ledger were lost; the
// ledger exists so we DO NOT re-scan the whole capture store on every boot.

import { all as storeAll, insert as storeInsert, findByField } from '../store.js';
import { run as captureToEventsRun } from './2026-05-19-capture-to-events.js';

const LEDGER_TABLE = 'kolm_migrations';

// Canonical, ordered migration registry. id MUST be stable + unique (it is the
// ledger key). `run(opts)` returns a stats object; `description` is surfaced in
// the CLI/dry-run output.
export const MIGRATIONS = [
  {
    id: '2026-05-19-capture-to-events',
    description: 'Backfill the canonical event-store from every legacy capture-store observation row.',
    run: captureToEventsRun,
  },
];

// Has this migration already been recorded as applied?
export function isMigrationApplied(id) {
  try {
    const rows = findByField(LEDGER_TABLE, 'migration_id', id);
    return rows.some((r) => r && r.status === 'applied');
  } catch {
    return false;
  }
}

// Record a successful apply in the ledger. Idempotent: a second record for the
// same id just appends another audit row (the isMigrationApplied check short-
// circuits before we ever get here on a re-run).
function recordApplied(id, stats) {
  try {
    storeInsert(LEDGER_TABLE, {
      id: 'mig_' + id + '_' + Date.now().toString(36),
      migration_id: id,
      status: 'applied',
      applied_at: new Date().toISOString(),
      stats: stats || null,
    });
  } catch (e) {
    // The migration's effect already landed (event-store is INSERT-OR-REPLACE);
    // a ledger write failure must not be reported as a migration failure, but
    // it does mean we may re-scan next boot. Surface it.
    if (process.env.KOLM_DEBUG) console.error('[migrate] ledger write failed for ' + id + ': ' + e.message);
  }
}

// listMigrations(): canonical registry annotated with applied state, for the
// CLI status view.
export function listMigrations() {
  return MIGRATIONS.map((m) => ({
    id: m.id,
    description: m.description,
    applied: isMigrationApplied(m.id),
  }));
}

// runPendingMigrations({ dryRun, only }): run every registered migration that
// is not yet recorded as applied, in registry order. dryRun runs each
// migration's own dry-run (no writes) and does NOT touch the ledger. `only` is
// an optional migration id to run just one. Returns
// { ran:[{id, stats}], skipped:[ids], dry_run }.
export async function runPendingMigrations(opts = {}) {
  const dryRun = !!opts.dryRun;
  const only = opts.only || null;
  const out = { ran: [], skipped: [], dry_run: dryRun };
  for (const m of MIGRATIONS) {
    if (only && m.id !== only) continue;
    if (!dryRun && isMigrationApplied(m.id)) {
      out.skipped.push(m.id);
      continue;
    }
    let stats;
    try {
      stats = await m.run({ ...opts, dryRun });
    } catch (e) {
      out.ran.push({ id: m.id, error: String((e && e.message) || e) });
      continue;
    }
    out.ran.push({ id: m.id, stats });
    if (!dryRun) recordApplied(m.id, stats);
  }
  return out;
}

// migrationStatus(): a JSON-able summary the CLI/health surface can print -
// every registered migration with applied/pending state and the ledger rows.
export function migrationStatus() {
  let ledger = [];
  try { ledger = storeAll(LEDGER_TABLE); } catch { ledger = []; }
  return {
    migrations: listMigrations(),
    ledger_rows: ledger.length,
    ledger: ledger.map((r) => ({ migration_id: r.migration_id, status: r.status, applied_at: r.applied_at })),
  };
}

export default { MIGRATIONS, runPendingMigrations, listMigrations, isMigrationApplied, migrationStatus };
