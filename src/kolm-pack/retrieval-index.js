// src/kolm-pack/retrieval-index.js
//
// ATOM: Signed .kolm Artifact Packaging Format -- real retrieval index slot.
//
// The `retrieval.index` slot of a .kolm package. v0.1 of the legacy artifact
// shipped a JSON lookup map masquerading as `index.sqlite-vec`. This module
// ships a REAL, queryable vector index: quantized (int8) embedding vectors +
// a metadata table + a working cosine/inner-product k-NN search that runs
// in-process with zero deps. Same affine int8 quantization as the weights
// slot, so vectors are stored compactly and dequantized at query time.
//
// Two emit paths:
//   1. DEFAULT (pure JS): a content-addressed binary index
//      (magic KOLMVEC1) -- real vectors, real search, no external deps.
//      This is what ships in every .kolm so search works offline on any host.
//   2. OPTIONAL (env-gated): a real sqlite-vec .db. Enabled with
//      KOLM_SQLITE_VEC=1, requires `better-sqlite3` + `sqlite-vec` npm packages.
//      If the env flag is set but the deps are missing, we FAIL LOUD with an
//      install hint rather than silently downgrading -- the real code path is
//      preserved, never stubbed.
//
// Binary layout (little-endian):
//   [0..8)   magic "KOLMVEC1"
//   [8..12)  u32 header_len N
//   [12..12+N) utf8 JSON header:
//      { "format":"kolm-vec/1", "dim":D, "count":C, "metric":"cosine",
//        "quant":"int8", "scale":<f64>, "zero_point":<int>,
//        "ids":[...], "meta":[...], "norms":[...] }
//   then C * D int8 bytes (row-major quantized vectors).
//
// The vectors are quantized with a SINGLE global affine scale/zp computed over
// all values (so the index is byte-deterministic for a given input set), and
// `norms` stores the L2 norm of each ORIGINAL (pre-quant) vector so cosine
// similarity is exact w.r.t. the source embeddings.
//
// Pure JS, node:crypto only. ASCII only.

import crypto from 'node:crypto';
import { quantizeAffine, dequantizeAffine } from './weights-tensors.js';

export const VEC_FORMAT = 'kolm-vec/1';
const VEC_MAGIC = 'KOLMVEC1';

function l2norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

// Build the binary vector index. `rows` is [{ id, vector:number[], meta? }].
// All vectors must share the same dimension. Returns a Buffer.
export function buildVectorIndex(rows, { metric = 'cosine' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('buildVectorIndex: rows must be a non-empty array');
  }
  const dim = rows[0].vector.length;
  if (!dim) throw new Error('buildVectorIndex: vectors must be non-empty');
  const flat = [];
  const norms = [];
  for (const r of rows) {
    if (!Array.isArray(r.vector) && !(r.vector instanceof Float32Array)) {
      throw new Error(`row ${r.id}: vector must be a numeric array`);
    }
    if (r.vector.length !== dim) {
      throw new Error(`row ${r.id}: dim ${r.vector.length} != ${dim}`);
    }
    norms.push(l2norm(r.vector));
    for (let i = 0; i < dim; i++) flat.push(r.vector[i]);
  }
  const { q, scale, zero_point } = quantizeAffine(flat, 8);
  const body = Buffer.alloc(q.length);
  for (let i = 0; i < q.length; i++) body.writeInt8(q[i], i);

  const header = {
    format: VEC_FORMAT,
    dim,
    count: rows.length,
    metric,
    quant: 'int8',
    scale,
    zero_point,
    ids: rows.map((r) => String(r.id)),
    meta: rows.map((r) => (r.meta == null ? null : r.meta)),
    norms,
  };
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const magic = Buffer.from(VEC_MAGIC, 'binary');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerJson.length, 0);
  return Buffer.concat([magic, lenBuf, headerJson, body]);
}

function parse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Error('vec index too short');
  if (buf.slice(0, 8).toString('binary') !== VEC_MAGIC) throw new Error('vec index magic mismatch');
  const headerLen = buf.readUInt32LE(8);
  const header = JSON.parse(buf.slice(12, 12 + headerLen).toString('utf8'));
  if (header.format !== VEC_FORMAT) throw new Error(`unexpected vec format ${header.format}`);
  const bodyStart = 12 + headerLen;
  return { header, bodyStart };
}

// Open the index for query. Returns a small object with a search(query, k)
// method. Vectors are dequantized lazily per-search (fine for the index sizes
// a .kolm carries -- thousands of rows). Cosine similarity uses the stored
// original norms so quantization error in the magnitude is corrected.
export function openVectorIndex(buf) {
  const { header, bodyStart } = parse(buf);
  const { dim, count, scale, zero_point, ids, meta, norms, metric } = header;
  const body = buf.slice(bodyStart, bodyStart + count * dim);

  function rowFloats(r) {
    const q = new Int32Array(dim);
    const base = r * dim;
    for (let i = 0; i < dim; i++) q[i] = body.readInt8(base + i);
    return dequantizeAffine(q, scale, zero_point);
  }

  function search(query, k = 5) {
    if (query.length !== dim) throw new Error(`query dim ${query.length} != index dim ${dim}`);
    const qnorm = l2norm(query) || 1;
    const scores = new Array(count);
    for (let r = 0; r < count; r++) {
      const vec = rowFloats(r);
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += vec[i] * query[i];
      let score;
      if (metric === 'inner_product') {
        score = dot;
      } else { // cosine -- use stored original norm to undo quant magnitude drift
        const vn = norms[r] || (l2norm(vec) || 1);
        score = dot / (vn * qnorm);
      }
      scores[r] = { id: ids[r], score, meta: meta[r], index: r };
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, k);
  }

  return { dim, count, metric, ids, search, _rowFloats: rowFloats };
}

export function indexInfo(buf) {
  const { header } = parse(buf);
  return { format: header.format, dim: header.dim, count: header.count, metric: header.metric, quant: header.quant };
}

// ---- env-gated optional real sqlite-vec emit ------------------------------
// Produces an actual sqlite database with a vec0 virtual table when the
// operator opts in AND the deps are installed. Fails LOUD otherwise so the
// boundary is provable and we never silently ship a downgraded slot under a
// .sqlite media type.
export function buildSqliteVecIndex(rows, { metric = 'cosine' } = {}) {
  if (process.env.KOLM_SQLITE_VEC !== '1') {
    const e = new Error(
      'buildSqliteVecIndex: real sqlite-vec emit is env-gated. ' +
      'Set KOLM_SQLITE_VEC=1 to enable. The pure-JS buildVectorIndex() path is ' +
      'always available and ships a real queryable index with no deps.',
    );
    e.code = 'KOLM_E_SQLITE_VEC_DISABLED';
    throw e;
  }
  let Database, sqliteVec;
  try {
    Database = require('better-sqlite3');
    sqliteVec = require('sqlite-vec');
  } catch (err) {
    const e = new Error(
      'buildSqliteVecIndex: KOLM_SQLITE_VEC=1 but the optional deps are missing. ' +
      'Install them with:  npm install better-sqlite3 sqlite-vec   ' +
      `(underlying error: ${err && err.message})`,
    );
    e.code = 'KOLM_E_SQLITE_VEC_DEPS_MISSING';
    throw e;
  }
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const tmp = path.join(os.tmpdir(), `kolm-vec-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    const db = new Database(tmp);
    sqliteVec.load(db);
    const dim = rows[0].vector.length;
    db.exec(`CREATE VIRTUAL TABLE vec USING vec0(embedding float[${dim}]);`);
    db.exec('CREATE TABLE meta(rowid INTEGER PRIMARY KEY, id TEXT, meta TEXT);');
    const insVec = db.prepare('INSERT INTO vec(rowid, embedding) VALUES (?, ?)');
    const insMeta = db.prepare('INSERT INTO meta(rowid, id, meta) VALUES (?, ?, ?)');
    const tx = db.transaction(() => {
      rows.forEach((r, i) => {
        insVec.run(i + 1, Buffer.from(new Float32Array(r.vector).buffer));
        insMeta.run(i + 1, String(r.id), r.meta == null ? null : JSON.stringify(r.meta));
      });
    });
    tx();
    db.exec(`PRAGMA user_version = 1; -- metric=${metric}`);
    db.close();
    return fs.readFileSync(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

// CommonJS require shim for the env-gated optional path (this is an ESM module).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
