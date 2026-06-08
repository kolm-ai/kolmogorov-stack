// Durable point-in-time backups for the kolm data layer.
//
// The production datastore is SQLite on a Railway persistent volume (see
// docs/durability.md for why that is the correct choice for this synchronous,
// single-instance architecture). A persistent volume survives container
// restarts, but does NOT protect against logical corruption, an accidental
// `reset`, a bad migration, or a volume-level failure. This module closes that
// gap with consistent, restorable point-in-time snapshots.
//
// Design contract:
//   - Fully SYNCHRONOUS, matching src/store.js (node:sqlite + JSON files are
//     both synchronous). Safe to call from a setInterval tick or from inside a
//     SIGTERM handler where async work cannot be awaited.
//   - NEVER throws across the public boundary. Every entry point returns a
//     structured result ({ ok, path|error, ... }) so a backup failure is logged
//     without taking down the scheduler or blocking graceful shutdown.
//   - SQLite snapshots use `VACUUM INTO`, which produces a fully consistent,
//     self-contained copy of the live database ONLINE (no writer downtime; it
//     reads through the WAL so committed rows are captured). JSON snapshots copy
//     the `*.json` table files into a timestamped directory.
//
// WHERE the data lives is read from the store's own backendInfo() so there is a
// single source of truth (no duplicated DATA_DIR / driver resolution that could
// drift from src/store.js). Tests inject an explicit `info` of the same shape to
// exercise both drivers hermetically inside one process.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { backendInfo } from './store.js';

const require = createRequire(import.meta.url);

// Default number of snapshots to retain when pruning.
export const DEFAULT_KEEP = 14;

// Resolve the backups directory for a given store info.
function backupsDirFor(info) {
  return path.join(info.data_dir, 'backups');
}

// The backups directory for the live store (logged at boot by server.js).
// Returns null if the store info cannot be resolved.
export function backupDir() {
  try { return backupsDirFor(backendInfo()); }
  catch { return null; }
}

// Filesystem-safe timestamp, e.g. 2026-06-09T12-34-56-789Z. Colons and dots are
// illegal in filenames on Windows and awkward everywhere else, so flatten them.
function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

// Pick a non-colliding target path. backupNow() can be called twice within the
// same millisecond (a scheduled tick racing a SIGTERM snapshot, or a tight test
// loop); append a counter so we never clobber an existing snapshot or trip
// VACUUM INTO's "output file already exists" rule. `ext` is '' for the JSON
// driver's directory target and '.sqlite' for the SQLite file target.
function uniquePath(base, ext) {
  let candidate = `${base}${ext}`;
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${base}-${n}${ext}`;
    n += 1;
  }
  return candidate;
}

function backupSqlite(info, dir) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (err) { return { ok: false, error: `node:sqlite unavailable: ${err.message}` }; }

  const dbPath = info.db_path;
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { ok: false, error: `sqlite db not found at ${dbPath || '(unset)'}` };
  }

  const target = uniquePath(path.join(dir, `kolm-${stamp()}`), '.sqlite');
  let db = null;
  try {
    // Open a fresh, independent connection to the live DB. VACUUM INTO only
    // takes a read transaction on the source, which is compatible with the
    // server's writer connection under WAL. busy_timeout absorbs the brief
    // lock contention of a concurrent checkpoint.
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 30000;');
    // VACUUM INTO writes a consistent, self-contained snapshot. Escape single
    // quotes defensively even though `target` is fully server-controlled.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (err) {
    try { if (fs.existsSync(target)) fs.rmSync(target, { force: true }); } catch { /* best-effort cleanup */ }
    return { ok: false, error: `VACUUM INTO failed: ${err.message}` };
  } finally {
    try { db?.close(); } catch { /* best-effort cleanup */ }
  }

  let bytes = 0;
  try { bytes = fs.statSync(target).size; } catch { /* size is informational */ }
  return { ok: true, path: target, driver: 'sqlite', bytes };
}

function backupJson(info, dir) {
  const src = info.data_dir;
  const target = uniquePath(path.join(dir, `kolm-${stamp()}`), '');
  try {
    fs.mkdirSync(target, { recursive: true });
    let files = 0;
    // Copy only top-level *.json table files. The backups/ subdir, cache/,
    // keys/, and `.json.bak` / `.corrupt-*` siblings are intentionally skipped.
    for (const name of fs.readdirSync(src)) {
      if (!name.endsWith('.json')) continue;
      const from = path.join(src, name);
      try { if (!fs.statSync(from).isFile()) continue; }
      catch { continue; }
      fs.copyFileSync(from, path.join(target, name));
      files += 1;
    }
    return { ok: true, path: target, driver: 'json', files };
  } catch (err) {
    try { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    return { ok: false, error: `json snapshot failed: ${err.message}` };
  }
}

// Create one consistent, restorable snapshot of the live store. Synchronous;
// never throws. Returns { ok:true, path, driver, ... } or { ok:false, error }.
//   opts.info  store config of backendInfo() shape ({ driver, data_dir, db_path }).
//              Defaults to the live store. Tests inject this to drive both
//              backends without fighting the ESM module cache.
export function backupNow(opts = {}) {
  let info;
  try { info = opts.info || backendInfo(); }
  catch (err) { return { ok: false, error: `cannot resolve store info: ${err.message}` }; }

  let dir;
  try {
    dir = backupsDirFor(info);
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `cannot create backups dir: ${err.message}` };
  }

  try {
    return info.driver === 'sqlite' ? backupSqlite(info, dir) : backupJson(info, dir);
  } catch (err) {
    // Defensive: backupSqlite/backupJson already trap their own errors, but the
    // boundary must never throw.
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// List existing snapshots, oldest first. Never throws; returns [] on any error
// (including a missing backups dir). Each entry: { name, path, kind, size, mtime_ms }.
export function listBackups(opts = {}) {
  let info;
  try { info = opts.info || backendInfo(); }
  catch { return []; }

  const dir = backupsDirFor(info);
  let entries;
  try { entries = fs.readdirSync(dir); }
  catch { return []; }

  const out = [];
  for (const name of entries) {
    if (!name.startsWith('kolm-')) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); }
    catch { continue; }
    let kind = null;
    if (stat.isDirectory()) kind = 'json';
    else if (name.endsWith('.sqlite')) kind = 'sqlite';
    if (!kind) continue;
    out.push({ name, path: full, kind, size: stat.size, mtime_ms: stat.mtimeMs });
  }
  // ISO timestamps sort lexically == chronologically, so a name sort is a
  // stable oldest-first ordering across both file (sqlite) and dir (json) kinds.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Retain the most recent `keep` snapshots (default 14); delete the rest.
// Synchronous; never throws. Returns { ok, kept, pruned: [names...] }.
export function pruneBackups(keep = DEFAULT_KEEP, opts = {}) {
  const n = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : DEFAULT_KEEP;
  let info;
  try { info = opts.info || backendInfo(); }
  catch (err) { return { ok: false, error: `cannot resolve store info: ${err.message}`, kept: 0, pruned: [] }; }

  const all = listBackups({ info }); // oldest first
  if (all.length <= n) return { ok: true, kept: all.length, pruned: [] };

  const toPrune = all.slice(0, all.length - n);
  const pruned = [];
  for (const b of toPrune) {
    try {
      fs.rmSync(b.path, { recursive: true, force: true });
      pruned.push(b.name);
    } catch { /* best-effort: a locked snapshot is retried next sweep */ }
  }
  return { ok: true, kept: all.length - pruned.length, pruned };
}
