// W888-B - Postgres capture store.
//
// Optional capture backend for tenants who want their captures in a managed
// Postgres (Supabase, Neon, RDS, Cloud SQL, ...) instead of the default
// append-only JSONL files under ~/.kolm/captures.jsonl.
//
// Activation:
//   export KOLM_CAPTURE_POSTGRES_URL=postgres://user:pass@host:5432/db
//   (or pass connectionString explicitly to the constructor)
//
// Caveats / Constraints / Limitations:
//   1. `pg` is lazy-imported. If the env var is not set, this module never
//      touches `pg` so the production install does not require it.
//   2. We do NOT manage the `pg.Pool` lifecycle for the caller - call
//      `await store.close()` from your shutdown handler.
//   3. PII redaction happens BEFORE rows hit insert(); this store does not
//      scrub. If you bypass the capture pipeline and call insert() directly,
//      the raw text lands in JSONB columns as-is.
//   4. The chain_hash column is a SHA-256 hex digest of canonical JSON of the
//      capture row - kept identical to the JSONL chain so a Postgres-backed
//      tenant can still verify receipts against the same hash chain logic.
//   5. We use NUMERIC/JSONB/TIMESTAMPTZ types only. No vendor-specific types,
//      so this works on Postgres 12+ AND on the Postgres-compatible front of
//      Supabase / Neon / CockroachDB-pg.

import crypto from 'node:crypto';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS captures (
  id            TEXT PRIMARY KEY,
  namespace     TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_json  JSONB NOT NULL,
  response_json JSONB NOT NULL,
  prev_chain    TEXT,
  chain_hash    TEXT NOT NULL,
  pii_mode      TEXT,
  metadata      JSONB
);
CREATE INDEX IF NOT EXISTS idx_captures_namespace ON captures(namespace);
CREATE INDEX IF NOT EXISTS idx_captures_tenant ON captures(tenant_id);
CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_chain_hash ON captures(chain_hash);
`;

function _sha256Json(obj) {
  const str = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash('sha256').update(str).digest('hex');
}

function _now() { return new Date().toISOString(); }

function _newId() {
  return 'cap_' + crypto.randomBytes(12).toString('hex');
}

// Lazy pg load. We require this module to be optional - `npm install` of the
// base stack does NOT bring in `pg` unless the user opts in.
async function _loadPg() {
  try {
    const mod = await import('pg');
    return mod.default || mod;
  } catch (e) {
    const err = new Error("pg driver not installed. Run: npm install pg");
    err.code = 'pg_not_installed';
    err.cause = e;
    err.install_hint = 'npm install pg   # then re-run kolm';
    err.docs_url = 'https://node-postgres.com/';
    throw err;
  }
}

export class PostgresCaptureStore {
  constructor({ connectionString, pool, ssl, max = 10, idleTimeoutMs = 30000 } = {}) {
    this.connectionString = connectionString
      || process.env.KOLM_CAPTURE_POSTGRES_URL
      || process.env.DATABASE_URL
      || '';
    if (!this.connectionString && !pool) {
      const err = new Error('PostgresCaptureStore: no connection string. Set KOLM_CAPTURE_POSTGRES_URL or pass {connectionString}.');
      err.code = 'pg_no_connection_string';
      err.install_hint = 'export KOLM_CAPTURE_POSTGRES_URL=postgres://user:pass@host:5432/db';
      throw err;
    }
    this._pool = pool || null;            // lazy-init
    this._poolPromise = null;
    this._sslOpt = ssl;
    this._maxConn = max;
    this._idleTimeoutMs = idleTimeoutMs;
    this._closed = false;
  }

  async _pg() {
    if (this._pool) return this._pool;
    if (!this._poolPromise) {
      this._poolPromise = (async () => {
        const pg = await _loadPg();
        const cfg = {
          connectionString: this.connectionString,
          max: this._maxConn,
          idleTimeoutMillis: this._idleTimeoutMs,
        };
        if (this._sslOpt !== undefined) cfg.ssl = this._sslOpt;
        else if (/sslmode=require/.test(this.connectionString)) cfg.ssl = { rejectUnauthorized: false };
        this._pool = new pg.Pool(cfg);
        return this._pool;
      })();
    }
    return this._poolPromise;
  }

  // migrate() - idempotent. Safe to call on every boot. Throws with an
  // install_hint if the connection itself fails so the caller can surface
  // a setup checklist.
  async migrate() {
    const pool = await this._pg();
    try {
      await pool.query(SCHEMA_SQL);
      return { ok: true, schema: 'captures', applied: true };
    } catch (e) {
      const err = new Error(`postgres migrate failed: ${e.message}`);
      err.code = 'pg_migrate_failed';
      err.cause = e;
      err.install_hint = 'Verify KOLM_CAPTURE_POSTGRES_URL is reachable and the user has CREATE TABLE permission.';
      throw err;
    }
  }

  // insert(capture) - upserts a single capture row. Returns the canonical row
  // including the computed chain_hash.
  async insert(capture) {
    if (!capture || typeof capture !== 'object') {
      const err = new Error('insert(capture) requires an object'); err.code = 'bad_args'; throw err;
    }
    const row = this._buildRow(capture);
    const pool = await this._pg();
    const sql = `INSERT INTO captures
      (id, namespace, tenant_id, created_at, request_json, response_json,
       prev_chain, chain_hash, pii_mode, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO NOTHING
      RETURNING id, chain_hash`;
    const vals = [
      row.id, row.namespace, row.tenant_id, row.created_at,
      JSON.stringify(row.request_json), JSON.stringify(row.response_json),
      row.prev_chain, row.chain_hash, row.pii_mode,
      row.metadata ? JSON.stringify(row.metadata) : null,
    ];
    try {
      const res = await pool.query(sql, vals);
      const inserted = res.rows && res.rows.length > 0;
      return { ok: true, inserted, id: row.id, chain_hash: row.chain_hash };
    } catch (e) {
      const err = new Error(`postgres insert failed: ${e.message}`);
      err.code = 'pg_insert_failed';
      err.cause = e;
      throw err;
    }
  }

  // bulkInsert(rows) - batch insert with a single multi-row statement. Returns
  // a per-row result array.
  async bulkInsert(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: true, inserted: 0, ids: [] };
    }
    const built = rows.map((r) => this._buildRow(r));
    const pool = await this._pg();
    const valuePlaceholders = [];
    const vals = [];
    let i = 1;
    for (const row of built) {
      valuePlaceholders.push(
        `($${i++},$${i++},$${i++},$${i++},$${i++}::jsonb,$${i++}::jsonb,$${i++},$${i++},$${i++},$${i++}::jsonb)`
      );
      vals.push(
        row.id, row.namespace, row.tenant_id, row.created_at,
        JSON.stringify(row.request_json), JSON.stringify(row.response_json),
        row.prev_chain, row.chain_hash, row.pii_mode,
        row.metadata ? JSON.stringify(row.metadata) : null,
      );
    }
    const sql = `INSERT INTO captures
      (id, namespace, tenant_id, created_at, request_json, response_json,
       prev_chain, chain_hash, pii_mode, metadata)
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (id) DO NOTHING
      RETURNING id`;
    try {
      const res = await pool.query(sql, vals);
      return { ok: true, inserted: res.rows.length, ids: res.rows.map((r) => r.id) };
    } catch (e) {
      const err = new Error(`postgres bulkInsert failed: ${e.message}`);
      err.code = 'pg_bulk_insert_failed';
      err.cause = e;
      throw err;
    }
  }

  // findByNamespace({namespace, limit, offset}) - paginated read newest-first.
  async findByNamespace({ namespace, limit = 100, offset = 0, tenantId = null } = {}) {
    if (!namespace) { const err = new Error('namespace required'); err.code = 'bad_args'; throw err; }
    const pool = await this._pg();
    const parts = ['SELECT * FROM captures WHERE namespace = $1'];
    const vals = [namespace];
    if (tenantId) { parts.push(`AND tenant_id = $${vals.length + 1}`); vals.push(tenantId); }
    parts.push(`ORDER BY created_at DESC LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`);
    vals.push(Number(limit) || 100, Number(offset) || 0);
    try {
      const res = await pool.query(parts.join(' '), vals);
      return { ok: true, rows: res.rows.map(_normalizeRow), namespace, limit, offset, count: res.rows.length };
    } catch (e) {
      const err = new Error(`postgres findByNamespace failed: ${e.message}`);
      err.code = 'pg_find_failed'; err.cause = e; throw err;
    }
  }

  // findByChainTail(hash) - returns the row at the tail of a hash chain.
  // Used by receipt verification to walk back through the chain.
  async findByChainTail(hash) {
    if (!hash) { const err = new Error('hash required'); err.code = 'bad_args'; throw err; }
    const pool = await this._pg();
    try {
      const res = await pool.query(
        'SELECT * FROM captures WHERE chain_hash = $1 LIMIT 1', [hash]
      );
      if (!res.rows.length) return { ok: true, row: null };
      return { ok: true, row: _normalizeRow(res.rows[0]) };
    } catch (e) {
      const err = new Error(`postgres findByChainTail failed: ${e.message}`);
      err.code = 'pg_find_failed'; err.cause = e; throw err;
    }
  }

  // count({namespace, tenantId}) - row count for a namespace (and optional tenant).
  async count({ namespace = null, tenantId = null } = {}) {
    const pool = await this._pg();
    const parts = ['SELECT COUNT(*)::int AS n FROM captures'];
    const where = []; const vals = [];
    if (namespace) { where.push(`namespace = $${vals.length + 1}`); vals.push(namespace); }
    if (tenantId)  { where.push(`tenant_id = $${vals.length + 1}`); vals.push(tenantId); }
    if (where.length) parts.push('WHERE ' + where.join(' AND '));
    try {
      const res = await pool.query(parts.join(' '), vals);
      return { ok: true, count: res.rows[0] ? res.rows[0].n : 0 };
    } catch (e) {
      const err = new Error(`postgres count failed: ${e.message}`);
      err.code = 'pg_count_failed'; err.cause = e; throw err;
    }
  }

  async deleteById(id) {
    if (!id) { const err = new Error('id required'); err.code = 'bad_args'; throw err; }
    const pool = await this._pg();
    try {
      const res = await pool.query('DELETE FROM captures WHERE id = $1 RETURNING id', [id]);
      return { ok: true, deleted: res.rows.length };
    } catch (e) {
      const err = new Error(`postgres deleteById failed: ${e.message}`);
      err.code = 'pg_delete_failed'; err.cause = e; throw err;
    }
  }

  async close() {
    if (this._closed) return { ok: true, closed: true, already: true };
    this._closed = true;
    if (!this._pool) return { ok: true, closed: true };
    try {
      await this._pool.end();
      this._pool = null;
      this._poolPromise = null;
      return { ok: true, closed: true };
    } catch (e) {
      return { ok: false, closed: false, error: e.message };
    }
  }

  _buildRow(capture) {
    const id = capture.id || _newId();
    const namespace = String(capture.namespace || 'default');
    const tenant_id = String(capture.tenant_id || capture.tenantId || 'public');
    const created_at = capture.created_at || _now();
    const request_json = capture.request_json || capture.request || {};
    const response_json = capture.response_json || capture.response || {};
    const prev_chain = capture.prev_chain || null;
    const pii_mode = capture.pii_mode || null;
    const metadata = capture.metadata || null;
    const chainInput = {
      id, namespace, tenant_id, created_at,
      request_json, response_json, prev_chain,
    };
    const chain_hash = capture.chain_hash || _sha256Json(chainInput);
    return { id, namespace, tenant_id, created_at, request_json, response_json, prev_chain, chain_hash, pii_mode, metadata };
  }
}

function _normalizeRow(r) {
  return {
    id: r.id,
    namespace: r.namespace,
    tenant_id: r.tenant_id,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    request_json: r.request_json,
    response_json: r.response_json,
    prev_chain: r.prev_chain || null,
    chain_hash: r.chain_hash,
    pii_mode: r.pii_mode || null,
    metadata: r.metadata || null,
  };
}

// detect(env) - never throws; returns {ok, configured, ...}. Used by
// `kolm test cloud --storage postgres` to decide between dry-run and live.
export function detect(env = process.env) {
  const url = env.KOLM_CAPTURE_POSTGRES_URL || env.DATABASE_URL || '';
  if (!url) {
    return {
      ok: false,
      provider: 'postgres',
      configured: false,
      reason: 'KOLM_CAPTURE_POSTGRES_URL not set',
      install_hint: 'export KOLM_CAPTURE_POSTGRES_URL=postgres://user:pass@host:5432/db',
      docs_url: 'https://node-postgres.com/features/connecting',
    };
  }
  // Mask password in url for surface output.
  let masked = url;
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    masked = u.toString();
  } catch { /* keep raw */ }
  return {
    ok: true,
    provider: 'postgres',
    configured: true,
    connection_string_masked: masked,
    pg_installed: null,           // unknown until we try; smoke does the check
  };
}

// smokePostgresStore(opts) - end-to-end smoke. Runs migrate, inserts a test row,
// reads it back, then deletes it. Returns {ok, latency_ms, ...} - never throws
// (errors are translated into ok:false with code + install_hint).
export async function smokePostgresStore({ env = process.env, connectionString = null } = {}) {
  const t0 = Date.now();
  const url = connectionString || env.KOLM_CAPTURE_POSTGRES_URL || env.DATABASE_URL || '';
  if (!url) {
    return {
      ok: false,
      target: 'postgres',
      latency_ms: Date.now() - t0,
      detail: {
        reason: 'KOLM_CAPTURE_POSTGRES_URL not set',
        install_hint: 'export KOLM_CAPTURE_POSTGRES_URL=postgres://user:pass@host:5432/db',
        docs_url: 'https://node-postgres.com/features/connecting',
      },
    };
  }
  let store;
  try {
    store = new PostgresCaptureStore({ connectionString: url });
  } catch (e) {
    return { ok: false, target: 'postgres', latency_ms: Date.now() - t0, detail: { error: e.message, code: e.code, install_hint: e.install_hint || null } };
  }
  try {
    await store.migrate();
    const testId = 'cap_smoke_' + crypto.randomBytes(6).toString('hex');
    const ins = await store.insert({
      id: testId,
      namespace: '_smoke',
      tenant_id: '_kolm_smoke',
      request_json: { ping: true },
      response_json: { pong: true },
      metadata: { smoke: true, at: _now() },
    });
    const cnt = await store.count({ namespace: '_smoke', tenantId: '_kolm_smoke' });
    const found = await store.findByChainTail(ins.chain_hash);
    await store.deleteById(testId);
    await store.close();
    return {
      ok: !!(ins.id && found.row && found.row.id === testId),
      target: 'postgres',
      latency_ms: Date.now() - t0,
      detail: {
        inserted_id: ins.id,
        chain_hash: ins.chain_hash,
        count_after_insert: cnt.count,
        round_trip_ok: !!(found.row && found.row.id === testId),
        cleaned_up: true,
      },
    };
  } catch (e) {
    try { await store.close(); } catch {} // deliberate: cleanup
    return {
      ok: false,
      target: 'postgres',
      latency_ms: Date.now() - t0,
      detail: { error: e.message, code: e.code || 'pg_smoke_failed', install_hint: e.install_hint || null },
    };
  }
}

export default PostgresCaptureStore;
export { SCHEMA_SQL };
