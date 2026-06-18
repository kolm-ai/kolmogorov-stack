// W369 - event-store: schema-validated wrapper over a local SQLite file.
//
// Storage layout: a single SQLite file at ~/.kolm/events/events.sqlite. We
// own the schema (one events table, JSON column) - separate from src/store.js
// which is the multi-purpose row store the server uses. We never want a
// rogue daemon-connector write to corrupt the rest of the kolm store.
//
// Driver selection:
//   - node:sqlite (built in to Node >= 22.5 / 20.x with --experimental-sqlite)
//   - falls back to a JSONL file (~/.kolm/events/events.jsonl) when sqlite
//     is unavailable. The fallback honors append-only semantics so partial
//     writes do not corrupt the whole log.
//
// Honors:
//   - KOLM_DATA_DIR (overrides ~/.kolm - used by tests with a temp HOME)
//   - KOLM_EVENT_STORE_PATH (point at any file; overrides KOLM_DATA_DIR)
//   - HOME (Linux/macOS), USERPROFILE (Windows)
//
// Public API: appendEvent, listEvents, getEvent, purgeEvents, streamEvents,
// exportEvents, countEvents, storeInfo, _resetForTests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { newEvent, validateEvent, canonicalize, backfillLegacy, EVENT_FIELDS } from './event-schema.js';

const require = createRequire(import.meta.url);

let _db = null;
let _driver = null; // 'sqlite' | 'jsonl'
let _eventsDir = null;
let _dbPath = null;
let _jsonlPath = null;
const _emitter = new EventEmitter();
_emitter.setMaxListeners(0);

// W411 P2 - last JSONL read diagnostics. _jsonlAll() writes here on every read
// so operators can surface "parsed N events, M lines failed" instead of silently
// dropping malformed lines. Reset on _resetForTests().
let _lastJsonlDiag = { parsed: 0, failed: 0, total_lines: 0, failed_lines: [], distinct_events: 0 };

// W409a-durability - last JSONL write diagnostics. The append path records
// duplicate rejections (same event_id as the tail line) + truncated-tail
// repairs here so /health and operator dashboards see write-time integrity
// events without KOLM_DEBUG=1. Reset on _resetForTests().
let _lastJsonlWriteDiag = {
  appends: 0,
  duplicates_rejected: 0,
  truncated_tail_repaired: 0,
  last_truncated_tail: null,
  last_event_id: null,
};

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _isTestRunner() {
  return process.env.NODE_ENV === 'test'
    || process.env.npm_lifecycle_event === 'test'
    || process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test-'))
    || process.argv.some((arg) => arg === '--test' || arg.startsWith('--test-') || /[\\/]tests[\\/].+\.test\.js$/i.test(arg));
}

function _dirWritable(d) {
  try { const t = path.join(d, '.wtest-' + process.pid); fs.writeFileSync(t, 'x'); fs.unlinkSync(t); return true; }
  catch { return false; }
}

// True if the path can be opened for append (creates it app-owned if absent).
function _appendable(p) {
  try { const fd = fs.openSync(p, 'a'); fs.closeSync(fd); return true; } catch { return false; }
}

// Atom3 - JSONL durability primitives, mirroring src/store.js writeFileDurably.
// The JSONL fallback is the path taken on Node <22.5 without --experimental-sqlite
// (many prod images), so it must be as crash-safe as the SQLite driver. Any
// FULL REWRITE of the append-only log (purge, compaction) routes through here:
// temp file in the same dir -> fsync fd -> atomic rename -> fsync dir, so a
// crash/power-loss mid-write never leaves a half-written or truncated log.
function _fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* dir fsync best-effort; not uniformly supported on Windows */ }
}

function _writeFileDurably(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // Windows can briefly hold the destination open (AV/indexing); retry rename
    // then fall back to copy, matching store.js replaceFileWithRetry intent.
    let renamed = false;
    for (let attempt = 0; attempt < 6 && !renamed; attempt += 1) {
      try { fs.renameSync(tmp, file); renamed = true; }
      catch (err) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(err && err.code)) throw err;
        const until = Date.now() + 10 * (2 ** attempt);
        while (Date.now() < until) { /* brief spin */ }
      }
    }
    if (!renamed) { fs.copyFileSync(tmp, file); try { fs.rmSync(tmp, { force: true }); } catch { /* */ } }
    _fsyncDir(path.dirname(file));
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
    throw err;
  }
}

// Atom3 (3) - keep a .jsonl.bak mirror so a corrupt primary can be recovered
// the way the JSON store recovers tables. Best-effort; a mirror failure must
// not block the primary rewrite.
function _bakPath() { return _jsonlPath + '.bak'; }
function _mirrorJsonlBak(text) {
  try { _writeFileDurably(_bakPath(), text); }
  catch (e) { if (process.env.KOLM_DEBUG) console.error('[event-store] jsonl .bak mirror failed:', e.message); }
}

// Atom3 (3) - quarantine a corrupt primary JSONL (rename to .corrupt-<ts>) and
// recover from the .bak mirror if present. Returns the recovered text or null.
function _recoverJsonlFromBak() {
  const bak = _bakPath();
  if (!fs.existsSync(bak)) return null;
  let text;
  try { text = fs.readFileSync(bak, 'utf8'); } catch { return null; }
  // Validate the backup parses to at least one usable event before trusting it.
  let usable = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.event_id) { usable = true; break; } } catch { /* */ }
  }
  if (!usable) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.renameSync(_jsonlPath, `${_jsonlPath}.corrupt-${stamp}-${process.pid}`); } catch { /* */ }
  try { _writeFileDurably(_jsonlPath, text); } catch { return null; }
  console.error('[event-store] recovered events.jsonl from .bak mirror after primary read failure');
  return text;
}

function _ensureDirs() {
  if (_eventsDir && fs.existsSync(_eventsDir)) return;
  const testMode = _isTestRunner();
  const base = process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : testMode
      ? path.join(os.tmpdir(), `kolm-event-store-test-${process.pid}`)
    : path.join(_home(), '.kolm');
  _eventsDir = path.join(base, 'events');
  fs.mkdirSync(_eventsDir, { recursive: true });
  // Self-heal: on a mounted volume, an events dir created by an earlier root-owned
  // deploy can be unwritable for a later non-root process - every append then fails
  // EACCES (broke conversation backup). If the default dir isn't writable, fall back
  // to a fresh app-owned sibling under the SAME data root, so writes succeed AND
  // persist on the volume. If even the data root is unwritable, the operator must fix
  // the volume mount perms (nothing we can do in-process).
  if (!_dirWritable(_eventsDir)) {
    const alt = path.join(base, 'events-rw');
    try { fs.mkdirSync(alt, { recursive: true }); } catch { /* */ }
    if (_dirWritable(alt)) {
      if (process.env.KOLM_DEBUG) console.error(`[event-store] ${_eventsDir} not writable; using ${alt}`);
      _eventsDir = alt;
    }
  }
  _dbPath = process.env.KOLM_EVENT_STORE_PATH
    ? path.resolve(process.env.KOLM_EVENT_STORE_PATH)
    : path.join(_eventsDir, 'events.sqlite');
  _jsonlPath = path.join(_eventsDir, 'events.jsonl');
  // Final guard: a store file left root-owned by a prior root-deploy can't be opened
  // for append (EACCES) even when its dir is writable. Switch to an app-owned alternate
  // name in the same (writable) dir - a fresh file is created app-owned, always writable.
  if (!_appendable(_dbPath)) _dbPath = path.join(_eventsDir, 'events-app.sqlite');
  if (!_appendable(_jsonlPath)) _jsonlPath = path.join(_eventsDir, 'events-app.jsonl');
}

function _openSqlite() {
  if (_db) return _db;
  _ensureDirs();
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    _driver = 'jsonl';
    return null;
  }
  try {
    _db = new DatabaseSync(_dbPath);
    _db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 30000;
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        created_at TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        status TEXT,
        sensitive_data_detected INTEGER NOT NULL DEFAULT 0,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        request_hash TEXT,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        workflow_id TEXT,
        media_kind TEXT,
        media_uri TEXT,
        media_hash TEXT,
        media_bytes INTEGER,
        media_mime TEXT,
        media_extraction_status TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ns_ts ON events(namespace, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_tenant_ts ON events(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_request_hash ON events(request_hash);
      CREATE INDEX IF NOT EXISTS idx_events_workflow ON events(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_events_provider_model ON events(provider, model);
      CREATE INDEX IF NOT EXISTS idx_events_media_kind ON events(media_kind);
      CREATE INDEX IF NOT EXISTS idx_events_media_hash ON events(media_hash);
      CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
    `);
    // W377 - additive ALTER TABLE for older DBs that pre-date the media_*
    // columns. SQLite has no ADD COLUMN IF NOT EXISTS, so we read pragma
    // table_info and only add what is missing. Idempotent + crash-safe.
    try {
      const existing = new Set(_db.prepare('PRAGMA table_info(events)').all().map(r => r.name));
      const toAdd = [
        ['media_kind', 'TEXT'],
        ['media_uri', 'TEXT'],
        ['media_hash', 'TEXT'],
        ['media_bytes', 'INTEGER'],
        ['media_mime', 'TEXT'],
        ['media_extraction_status', 'TEXT'],
      ];
      for (const [col, type] of toAdd) {
        if (!existing.has(col)) {
          try { _db.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`); } catch {} // deliberate: cleanup
        }
      }
    } catch {} // deliberate: cleanup
    _driver = 'sqlite';
    return _db;
  } catch (e) {
    _db = null;
    _driver = 'jsonl';
    return null;
  }
}

// Lazily pick the driver and return its name.
//
// W411 - KOLM_EVENT_STORE_DRIVER='jsonl' forces the JSONL path even when
// node:sqlite is available. Used by migration/backfill tests that need to
// seed a pre-W411 events.jsonl file directly. Production code should not
// set this env var.
function _ensureDriver() {
  if (_driver) return _driver;
  if (process.env.KOLM_EVENT_STORE_DRIVER === 'jsonl') {
    _ensureDirs();
    _driver = 'jsonl';
    return _driver;
  }
  _openSqlite();
  if (!_driver) _driver = 'jsonl';
  return _driver;
}

// Reset module state - only for tests that switch HOME / KOLM_DATA_DIR.
export function _resetForTests() {
  try { if (_db) _db.close(); } catch {} // deliberate: cleanup
  _db = null;
  _driver = null;
  _eventsDir = null;
  _dbPath = null;
  _jsonlPath = null;
  _lastJsonlDiag = { parsed: 0, failed: 0, total_lines: 0, failed_lines: [], distinct_events: 0 };
  _appendsSinceCompactCheck = 0;
  _emitter.removeAllListeners();
}

export function storeInfo() {
  _ensureDriver();
  return {
    driver: _driver,
    events_dir: _eventsDir,
    db_path: _driver === 'sqlite' ? _dbPath : null,
    jsonl_path: _driver === 'jsonl' ? _jsonlPath : null,
    jsonl_bak_path: _driver === 'jsonl' ? _bakPath() : null,
    // W411 P2 - last JSONL read accounting (null for the sqlite driver, which
    // has no line-parse failure surface). Forces a read so the diag is current.
    jsonl_diagnostics: _driver === 'jsonl' ? jsonlDiagnostics() : null,
  };
}

// W411 P2 - jsonlDiagnostics(): returns { parsed, failed, total_lines,
// failed_lines } from the most recent JSONL read, performing a read if none has
// happened yet. Operators / route handlers call this to surface "parsed N
// events, M lines failed" instead of silently losing rows. Returns a clean
// zeroed report for the sqlite driver (no JSONL parsing involved).
export function jsonlDiagnostics() {
  if (_ensureDriver() !== 'jsonl') {
    return { driver: _driver, parsed: 0, failed: 0, total_lines: 0, failed_lines: [] };
  }
  _jsonlAll(); // refresh _lastJsonlDiag against the current file
  return { driver: 'jsonl', ..._lastJsonlDiag, failed_lines: _lastJsonlDiag.failed_lines.slice() };
}

// appendEvent(partial): validate, canonicalize, write. Returns the persisted
// event. Throws on validation failure (with `.code = 'EVENT_INVALID'`) so the
// caller knows the row is rejected, not silently swallowed.
export async function appendEvent(partial = {}) {
  const ev = canonicalize(newEvent(partial));
  const v = validateEvent(ev);
  if (!v.ok) {
    const err = new Error('event_invalid: missing=' + v.missing.join(',') + ' errors=' + v.errors.join(','));
    err.code = 'EVENT_INVALID';
    err.missing = v.missing;
    err.errors = v.errors;
    throw err;
  }
  const drv = _ensureDriver();
  if (drv === 'sqlite') {
    const db = _openSqlite();
    db.prepare(
      `INSERT OR REPLACE INTO events (
        event_id, tenant_id, namespace, created_at, provider, model, status,
        sensitive_data_detected, cache_hit, request_hash, estimated_cost_usd,
        latency_ms, prompt_tokens, completion_tokens, workflow_id,
        media_kind, media_uri, media_hash, media_bytes, media_mime, media_extraction_status,
        json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      ev.event_id, ev.tenant_id, ev.namespace, ev.created_at,
      ev.provider, ev.model, ev.status,
      ev.sensitive_data_detected ? 1 : 0, ev.cache_hit ? 1 : 0,
      ev.request_hash, ev.estimated_cost_usd, ev.latency_ms,
      ev.prompt_tokens, ev.completion_tokens, ev.workflow_id,
      ev.media_kind, ev.media_uri, ev.media_hash, ev.media_bytes, ev.media_mime, ev.media_extraction_status,
      JSON.stringify(ev),
    );
  } else {
    _ensureDirs();
    // W552 - JSONL fallback stays append-only on write. Earlier W411 code
    // scanned and rewrote the whole file when the same event_id appeared,
    // which made connector capture O(n^2) because capture-store bridge +
    // canonical event append intentionally re-emit the same event_id. Read
    // paths already dedupe with last-write-wins in _jsonlAll(), so appending
    // preserves the public INSERT-OR-REPLACE contract without turning every
    // production capture into a full-file rewrite.
    fs.appendFileSync(_jsonlPath, JSON.stringify(ev) + '\n', 'utf8');
    // Atom3 (3) - keep the .bak mirror append-in-sync so a corrupt primary can
    // be recovered. Append (not full rewrite) preserves O(1) writes.
    try { fs.appendFileSync(_bakPath(), JSON.stringify(ev) + '\n', 'utf8'); }
    catch (e) { if (process.env.KOLM_DEBUG) console.error('[event-store] .bak append failed:', e.message); }
    // Atom3 (2) - self-heal JSONL dedupe bloat opportunistically.
    _maybeCompactJsonl();
  }
  _emitter.emit('event', ev);
  return ev;
}

function _jsonlAll() {
  _ensureDirs();
  let text;
  if (!fs.existsSync(_jsonlPath)) {
    // Atom3 (3) - primary missing: try to recover from the .bak mirror before
    // returning empty (e.g. a crash truncated/removed the primary).
    const recovered = _recoverJsonlFromBak();
    if (recovered == null) return [];
    text = recovered;
  } else {
    try {
      text = fs.readFileSync(_jsonlPath, 'utf8');
    } catch (readErr) {
      // Atom3 (3) - unreadable primary: recover from .bak or surface loudly.
      const recovered = _recoverJsonlFromBak();
      if (recovered == null) {
        console.error('[event-store] events.jsonl unreadable and no usable .bak mirror: ' + readErr.message);
        return [];
      }
      text = recovered;
    }
  }
  // Atom3 (3) - parse the primary; if it is non-empty but yields ZERO usable
  // events (every line failed), try to recover from the .bak mirror before
  // accepting "no events". The mirror is only trusted when it yields at least
  // one usable event; _recoverJsonlFromBak quarantines the corrupt primary.
  const parsedPrimary = _parseJsonlText(text);
  _lastJsonlDiag = parsedPrimary.diag;
  if (parsedPrimary.order.length === 0 && parsedPrimary.diag.total_lines > 0 && parsedPrimary.diag.failed > 0) {
    const recovered = _recoverJsonlFromBak();
    if (recovered != null) {
      const reparsed = _parseJsonlText(recovered);
      if (reparsed.order.length > 0) {
        _lastJsonlDiag = reparsed.diag;
        return reparsed.order.map(id => backfillLegacy(reparsed.seen.get(id)));
      }
    }
  }
  // W411 addendum #9 - apply backfillLegacy to every read so legacy JSONL rows
  // (pre-W411, missing tenant_id/source_type/review_state/production_eligible)
  // surface as canonical events with safe defaults. Idempotent on already-
  // canonical rows.
  return parsedPrimary.order.map(id => backfillLegacy(parsedPrimary.seen.get(id)));
}

// Atom3 - pure JSONL parser with last-write-wins dedupe + parse diagnostics.
// Shared by the primary read and the .bak recovery path. Returns
// { order:[event_id], seen:Map, diag:{parsed, failed, total_lines, failed_lines,
// distinct_events} }.
function _parseJsonlText(text) {
  // W411 P0 #6 - last-write-wins dedupe by event_id. Defends against legacy
  // JSONL files (pre-W411) with duplicate event_id lines from blind appends.
  const seen = new Map();
  const order = [];
  // W411 P2 - track parse failures so silent data loss is observable.
  let parsed = 0, failed = 0, totalLines = 0;
  const failedLines = [];
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    totalLines += 1;
    try {
      const row = JSON.parse(line);
      if (!row || !row.event_id) {
        failed += 1;
        if (failedLines.length < 50) failedLines.push({ line: lineNo, reason: 'missing_event_id' });
        continue;
      }
      if (!seen.has(row.event_id)) order.push(row.event_id);
      seen.set(row.event_id, row);
      parsed += 1;
    } catch (e) {
      failed += 1;
      if (failedLines.length < 50) failedLines.push({ line: lineNo, reason: String(e && e.message || e).slice(0, 120) });
      if (process.env.KOLM_DEBUG) {
        console.error('[event-store] JSONL parse error at line', lineNo, ':', String(line).slice(0, 100));
      }
    }
  }
  if (failed > 0 && process.env.KOLM_DEBUG) {
    console.error('[event-store] parsed ' + order.length + ' events, ' + failed + ' line(s) failed in ' + _jsonlPath);
  }
  return {
    order, seen,
    diag: { parsed, failed, total_lines: totalLines, failed_lines: failedLines, distinct_events: order.length },
  };
}

function _matchEvent(ev, q) {
  if (!ev) return false;
  if (q.namespace && ev.namespace !== q.namespace) return false;
  // W411 - accept both `tenant_id` (canonical) and `tenant` (shorthand used
  // by route handlers that pass req.tenant_record.id directly). Either one
  // restricts the read to that tenant; the seam is enforced here.
  const tenantFilter = q.tenant_id || q.tenant;
  if (tenantFilter && ev.tenant_id !== tenantFilter) return false;
  // W936 - team attribution filters (team dashboard "who asked what").
  if (q.team_id && ev.team_id !== q.team_id) return false;
  if (q.actor_id && ev.actor_id !== q.actor_id) return false;
  if (q.provider && ev.provider !== q.provider) return false;
  if (q.model && ev.model !== q.model) return false;
  if (q.workflow_id && ev.workflow_id !== q.workflow_id) return false;
  if (q.media_kind && ev.media_kind !== q.media_kind) return false;
  if (q.since && new Date(ev.created_at).getTime() < new Date(q.since).getTime()) return false;
  if (q.until && new Date(ev.created_at).getTime() > new Date(q.until).getTime()) return false;
  if (q.filter && typeof q.filter === 'function' && !q.filter(ev)) return false;
  return true;
}

// listEvents({namespace, tenant_id|tenant, provider, model, workflow_id, since, until, limit, filter}).
// Returns an array of events (newest first by default). limit defaults to
// 1000; pass 0 for unlimited (sparingly).
//
// W411 - `tenant` is a shorthand alias for `tenant_id`. Both filter on the
// canonical `tenant_id` column; route handlers that read req.tenant_record.id
// can pass either name without renaming at the call site.
export async function listEvents(query = {}) {
  const drv = _ensureDriver();
  const limit = query.limit == null ? 1000 : Math.max(0, Math.trunc(Number(query.limit)));
  const order = (query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const tenantFilter = query.tenant_id || query.tenant;
  if (drv === 'sqlite') {
    const db = _openSqlite();
    const where = [];
    const args = [];
    if (query.namespace) { where.push('namespace = ?'); args.push(query.namespace); }
    if (tenantFilter) { where.push('tenant_id = ?'); args.push(tenantFilter); }
    if (query.provider) { where.push('provider = ?'); args.push(query.provider); }
    if (query.model) { where.push('model = ?'); args.push(query.model); }
    if (query.workflow_id) { where.push('workflow_id = ?'); args.push(query.workflow_id); }
    if (query.media_kind) { where.push('media_kind = ?'); args.push(query.media_kind); }
    if (query.since) { where.push('created_at >= ?'); args.push(new Date(query.since).toISOString()); }
    if (query.until) { where.push('created_at <= ?'); args.push(new Date(query.until).toISOString()); }
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    const limSql = limit > 0 ? ('LIMIT ' + limit) : '';
    const sql = `SELECT json FROM events ${whereSql} ORDER BY created_at ${order} ${limSql}`;
    let rows = db.prepare(sql).all(...args).map(r => {
      try { return backfillLegacy(JSON.parse(r.json)); } catch { return null; }
    }).filter(Boolean);
    // W936 - team_id/actor_id live in the JSON payload, not as indexed columns,
    // so filter them post-parse (same place query.filter applies).
    if (query.team_id) rows = rows.filter(r => r.team_id === query.team_id);
    if (query.actor_id) rows = rows.filter(r => r.actor_id === query.actor_id);
    if (query.filter) return rows.filter(query.filter);
    return rows;
  }
  let rows = _jsonlAll().filter(ev => _matchEvent(ev, query));
  rows.sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return order === 'ASC' ? (ta - tb) : (tb - ta);
  });
  if (limit > 0) rows = rows.slice(0, limit);
  return rows;
}

export async function getEvent(eventId) {
  if (!eventId) return null;
  const drv = _ensureDriver();
  if (drv === 'sqlite') {
    const db = _openSqlite();
    const r = db.prepare('SELECT json FROM events WHERE event_id = ?').get(eventId);
    if (!r) return null;
    try { return backfillLegacy(JSON.parse(r.json)); } catch { return null; }
  }
  return _jsonlAll().find(ev => ev.event_id === eventId) || null;
}

// purgeEvents({before, namespace, tenant_id|tenant, dryRun}).
// Returns {deleted, would_delete}. Any supplied selector narrows the purge.
export async function purgeEvents(opts = {}) {
  const drv = _ensureDriver();
  const dryRun = !!opts.dryRun;
  const before = opts.before ? new Date(opts.before).toISOString() : null;
  const tenantFilter = opts.tenant_id || opts.tenant || null;
  if (drv === 'sqlite') {
    const db = _openSqlite();
    const where = [];
    const args = [];
    if (before) { where.push('created_at < ?'); args.push(before); }
    if (opts.namespace) { where.push('namespace = ?'); args.push(opts.namespace); }
    if (tenantFilter) { where.push('tenant_id = ?'); args.push(tenantFilter); }
    if (!where.length) return { deleted: 0, would_delete: 0 };
    const whereSql = 'WHERE ' + where.join(' AND ');
    const count = db.prepare(`SELECT COUNT(*) AS n FROM events ${whereSql}`).get(...args).n || 0;
    if (dryRun) return { deleted: 0, would_delete: count };
    db.prepare(`DELETE FROM events ${whereSql}`).run(...args);
    return { deleted: count, would_delete: count };
  }
  const all = _jsonlAll();
  const keep = [];
  let dropped = 0;
  for (const ev of all) {
    let drop = true;
    if (before && new Date(ev.created_at).getTime() >= new Date(before).getTime()) drop = false;
    if (opts.namespace && ev.namespace !== opts.namespace) drop = false;
    if (tenantFilter && ev.tenant_id !== tenantFilter) drop = false;
    if (drop && (before || opts.namespace || tenantFilter)) { dropped++; continue; }
    keep.push(ev);
  }
  if (dryRun) return { deleted: 0, would_delete: dropped };
  // Atom3 (1) - route the full-file rewrite through the durable write helper
  // (temp -> fsync -> atomic rename -> fsync dir) instead of a non-atomic
  // fs.writeFileSync that could truncate/corrupt the whole append-only log on a
  // crash mid-write. _jsonlAll() above already deduped last-write-wins, so this
  // rewrite ALSO compacts the file to one row per surviving event_id.
  const out = keep.map(e => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : '');
  _writeFileDurably(_jsonlPath, out);
  _mirrorJsonlBak(out);
  return { deleted: dropped, would_delete: dropped };
}

// Atom3 (2) - compactJsonl(): durably rewrite the JSONL log keeping only the
// last-write-wins row per event_id (the same semantics _jsonlAll() applies on
// read), collapsing the unbounded blind-append growth into one row per event.
// Routes through the durable write helper + .bak mirror. Returns
// { ok, before_lines, after_lines, distinct_events, compacted }.
//
// `opts.minRatio` (default 2): only compact when total_lines >= minRatio *
// distinct_events (i.e. at least 2x dedupe bloat) AND total_lines exceeds
// `opts.minLines` (default 1000). Pass opts.force=true to compact regardless.
export function compactJsonl(opts = {}) {
  if (_ensureDriver() !== 'jsonl') {
    return { ok: true, driver: _driver, compacted: false, reason: 'not_jsonl_driver' };
  }
  _ensureDirs();
  // _jsonlAll() refreshes _lastJsonlDiag (total_lines, distinct_events) and
  // returns the deduped, ordered, backfilled event set.
  const events = _jsonlAll();
  const diag = _lastJsonlDiag;
  const before = diag.total_lines || 0;
  const distinct = diag.distinct_events != null ? diag.distinct_events : events.length;
  const minRatio = Number.isFinite(opts.minRatio) && opts.minRatio > 1 ? opts.minRatio : 2;
  const minLines = Number.isFinite(opts.minLines) && opts.minLines >= 0 ? opts.minLines : 1000;
  const due = !!opts.force
    || (before > minLines && distinct > 0 && before >= minRatio * distinct);
  if (!due) {
    return { ok: true, compacted: false, before_lines: before, after_lines: before, distinct_events: distinct };
  }
  // Re-serialize the deduped canonical rows. We persist the raw stored shape
  // (events as returned, already backfilled) - idempotent on re-read.
  const out = events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  _writeFileDurably(_jsonlPath, out);
  _mirrorJsonlBak(out);
  return { ok: true, compacted: true, before_lines: before, after_lines: events.length, distinct_events: distinct };
}

// Atom3 (2) - opportunistic compaction trigger. Called from the append hot path
// at a coarse cadence so a long-lived process self-heals JSONL bloat without an
// operator running `compactJsonl()`. Cheap guard: only inspect the file once per
// _COMPACT_CHECK_EVERY appends, then defer to compactJsonl()'s ratio gate.
let _appendsSinceCompactCheck = 0;
const _COMPACT_CHECK_EVERY = 500;
function _maybeCompactJsonl() {
  _appendsSinceCompactCheck += 1;
  if (_appendsSinceCompactCheck < _COMPACT_CHECK_EVERY) return;
  _appendsSinceCompactCheck = 0;
  if (process.env.KOLM_EVENT_STORE_NO_AUTOCOMPACT === '1') return;
  try { compactJsonl(); } catch (e) {
    if (process.env.KOLM_DEBUG) console.error('[event-store] opportunistic compaction failed:', e.message);
  }
}

// streamEvents(cb): subscribe to live appendEvent emissions. Returns an
// unsubscribe function. The caller decides on namespace/tenant filtering.
export function streamEvents(cb) {
  if (typeof cb !== 'function') throw new Error('streamEvents requires a callback');
  _emitter.on('event', cb);
  return () => _emitter.off('event', cb);
}

// exportEvents({format, namespace, tenant_id, since, until, limit}).
//   format = 'jsonl' (default) | 'json' | 'csv'.
// Returns a string buffer.
//
// W411 - tenant_id forwarded to listEvents so routes that call /v1/lake/export
// only export the caller's rows.
export async function exportEvents(opts = {}) {
  const fmt = (opts.format || 'jsonl').toLowerCase();
  const rows = await listEvents({
    namespace: opts.namespace,
    tenant_id: opts.tenant_id || opts.tenant || null,
    team_id: opts.team_id || null, // W936 - team-scoped export
    since: opts.since,
    until: opts.until,
    limit: opts.limit == null ? 0 : opts.limit,
    order: 'asc',
  });
  if (fmt === 'jsonl') return rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  if (fmt === 'json') return JSON.stringify(rows, null, 2);
  if (fmt === 'csv') {
    const cols = EVENT_FIELDS;
    const head = cols.join(',');
    const lines = rows.map(r => cols.map(c => {
      const v = r[c];
      if (v == null) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(','));
    return [head, ...lines].join('\n') + '\n';
  }
  throw new Error('unsupported export format: ' + fmt);
}

export async function countEvents(query = {}) {
  const drv = _ensureDriver();
  // W411 - alias as in listEvents.
  const tenantFilter = query.tenant_id || query.tenant;
  if (drv === 'sqlite') {
    const db = _openSqlite();
    const where = [];
    const args = [];
    if (query.namespace) { where.push('namespace = ?'); args.push(query.namespace); }
    if (tenantFilter) { where.push('tenant_id = ?'); args.push(tenantFilter); }
    if (query.media_kind) { where.push('media_kind = ?'); args.push(query.media_kind); }
    if (query.since) { where.push('created_at >= ?'); args.push(new Date(query.since).toISOString()); }
    if (query.until) { where.push('created_at <= ?'); args.push(new Date(query.until).toISOString()); }
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    return db.prepare(`SELECT COUNT(*) AS n FROM events ${whereSql}`).get(...args).n || 0;
  }
  return (_jsonlAll().filter(ev => _matchEvent(ev, query))).length;
}

// W377 - filterByMediaKind({media_kind, namespace?, tenant_id?, limit?}).
// Convenience wrapper for the multimodal loaders that only care about, say,
// every 'pdf' or every 'audio' row. Forwards everything else to listEvents so
// you still get namespace + tenant + time-window filtering for free.
export async function filterByMediaKind(query = {}) {
  if (!query || !query.media_kind) {
    throw new Error('filterByMediaKind requires {media_kind}');
  }
  return listEvents(query);
}
