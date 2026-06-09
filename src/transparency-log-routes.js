// src/transparency-log-routes.js
//
// TRACK CRYPTO-SERVICES / M4 - the PUBLIC HTTP surface over the append-only,
// Merkle-witnessed transparency log (src/transparency-log.js).
//
// WHY PUBLIC
//   The whole point of a transparency log is third-party verifiability WITHOUT
//   trusting kolm. A buyer's monitor (or a Sigstore-style witness) must be able
//   to read the tree size, pull any entry, fetch an RFC 9162 inclusion proof,
//   and fetch a SIGNED tree head (checkpoint) - all over a no-account GET. These
//   routes are read-only and touch no tenant data; they serve the GLOBAL public
//   log (tenant_id = null). They must be added to PUBLIC_API in src/auth.js (see
//   the exact paths in the track caveats - this file does not own auth.js).
//
// ROUTES (register(r))
//   GET /v1/transparency-log/size                 -> { tree_size, root_hash }
//   GET /v1/transparency-log/entries/:seq         -> one entry + hashes
//   GET /v1/transparency-log/entries?start&end    -> a page of entries
//   GET /v1/transparency-log/proof/:seq           -> RFC 9162 inclusion proof
//   GET /v1/transparency-log/checkpoints/latest   -> current SIGNED tree head
//   GET /v1/transparency-log/checkpoints?from&to  -> history of signed heads
//
// WITNESS HOOK
//   Each checkpoint is signed by the log key and, when a witness is configured
//   (setTransparencyWitness or KOLM_TLOG_WITNESS_KEY), co-signed by the witness.
//   The cosign is transparent in the checkpoint's `witnesses` array; verifiers
//   use transparency-log.js verifyCosignedTreeHead. See docs/crypto-trust.md.

import { insert as storeInsert, find as storeFind } from './store.js';
import { loadOrCreateDefaultSigner } from './ed25519.js';
import {
  getTransparencyLog,
  signTreeHead,
  buildCheckpointNote,
  cosignTreeHead,
  persistCheckpoint,
  loadCheckpoints,
  TLOG_DEFAULT_ORIGIN,
  TRANSPARENCY_LOG_VERSION,
} from './transparency-log.js';

export const TRANSPARENCY_LOG_ROUTES_VERSION = 'kolm-tlog-routes-v1';

// The public log lives at the default origin with NO tenant fence (tenant_id
// null) so it is a single global witness. The store adapter is just the kolm
// store facade reshaped to the {insert,find} contract TransparencyLog expects.
const PUBLIC_ORIGIN = process.env.KOLM_TLOG_ORIGIN || TLOG_DEFAULT_ORIGIN;
const _storeAdapter = { insert: storeInsert, find: storeFind };

// Max entries returned in a single /entries page (a public read must not let a
// caller pull an unbounded slice in one request).
const MAX_PAGE = 1000;
const DEFAULT_PAGE = 100;

function publicLog() {
  return getTransparencyLog({ tenant_id: null, origin: PUBLIC_ORIGIN, store: _storeAdapter });
}

function _signer() {
  try { return loadOrCreateDefaultSigner(); } catch { return null; }
}

// Compute the current signed (and witness-cosigned) tree head. Falls back to an
// UNSIGNED head (signed:false) when no Ed25519 signer is configured, so the
// endpoint still serves the verifiable tree_size + root_hash.
function currentSignedHead() {
  const log = publicLog();
  const head = log.treeHead();
  const s = _signer();
  if (s && s.privateKey) {
    let signed = signTreeHead(head, s);
    signed = cosignTreeHead(signed); // no-op unless a witness is configured
    return signed;
  }
  return {
    origin: head.origin,
    tree_size: head.tree_size,
    root_hash: head.root_hash,
    root_b64: head.root_b64,
    note: buildCheckpointNote(head),
    alg: 'ed25519',
    signature: null,
    signed: false,
    reason: 'no_signer_configured',
    version: TRANSPARENCY_LOG_VERSION,
  };
}

// Persist the current head as a checkpoint (idempotent on origin+size+root).
function captureCheckpoint() {
  const signed = currentSignedHead();
  try { persistCheckpoint(_storeAdapter, signed, { origin: PUBLIC_ORIGIN }); } catch { /* best-effort */ }
  return signed;
}

function _entryView(row) {
  if (!row) return null;
  return {
    seq: row.seq,
    kind: row.kind,
    namespace: row.namespace,
    at: row.at,
    data: row.data === undefined ? null : row.data,
    prev_hash: row.prev_hash,
    entry_hash: row.entry_hash,
    leaf_hash: row.leaf_hash,
  };
}

function _toInt(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

// ---------------------------------------------------------------------------
// recordTransparencyEntry({ kind, data, namespace }) - the append SERVICE the
// rest of the product uses to anchor a public artifact (e.g. a signed report's
// digest) into the global log. Exported so a later wave can append without
// re-implementing the store wiring. NEVER throws; returns the appended entry
// (with seq + hashes) or { ok:false }.
// ---------------------------------------------------------------------------
export function recordTransparencyEntry({ kind, data, namespace = 'reports', at } = {}) {
  try {
    const row = publicLog().append(String(kind || 'entry'), data, { namespace, at });
    return { ok: true, entry: _entryView(row) };
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

export function getPublicTransparencyLog() {
  return publicLog();
}

export function register(r) {
  if (!r || typeof r.get !== 'function') {
    throw new Error('transparency-log-routes.register: router with get() required');
  }

  // GET /v1/transparency-log/size
  r.get('/v1/transparency-log/size', (req, res) => {
    try {
      const head = publicLog().treeHead();
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, origin: head.origin, tree_size: head.tree_size, root_hash: head.root_hash });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'tlog_size_failed', detail: e && e.message });
    }
  });

  // GET /v1/transparency-log/entries?start&end  (page of entries)
  r.get('/v1/transparency-log/entries', (req, res) => {
    try {
      const log = publicLog();
      const size = log.size();
      const q = req.query || {};
      let start = _toInt(q.start);
      let end = _toInt(q.end);
      if (start === null) start = 0;
      if (Number.isNaN(start) || start < 0) return res.status(400).json({ ok: false, error: 'bad_start' });
      if (end === null) end = Math.min(start + DEFAULT_PAGE, size);
      if (Number.isNaN(end) || end < start) return res.status(400).json({ ok: false, error: 'bad_end' });
      end = Math.min(end, size, start + MAX_PAGE);
      const rows = log._rows().slice(start, end).map(_entryView);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, origin: PUBLIC_ORIGIN, tree_size: size, start, end, count: rows.length, entries: rows });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'tlog_entries_failed', detail: e && e.message });
    }
  });

  // GET /v1/transparency-log/entries/:seq  (single entry)
  r.get('/v1/transparency-log/entries/:seq', (req, res) => {
    try {
      const seq = _toInt(req.params && req.params.seq);
      if (seq === null || Number.isNaN(seq) || seq < 0) return res.status(400).json({ ok: false, error: 'bad_seq' });
      const rows = publicLog()._rows();
      if (seq >= rows.length) return res.status(404).json({ ok: false, error: 'not_found', detail: `seq ${seq} out of range for tree size ${rows.length}` });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, origin: PUBLIC_ORIGIN, tree_size: rows.length, entry: _entryView(rows[seq]) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'tlog_entry_failed', detail: e && e.message });
    }
  });

  // GET /v1/transparency-log/proof/:seq  (RFC 9162 inclusion proof + signed head)
  //
  // The RFC 9162 / RFC 6962 inclusion-proof fields (leaf_index, tree_size,
  // audit_path, root_hash, leaf_hash) are surfaced at the TOP LEVEL so a buyer
  // can verify inclusion directly against verifyInclusionProof without reaching
  // into a nested object. The original `proof` + `checkpoint` keys are kept for
  // backward compatibility (older clients still read response.proof.*).
  r.get('/v1/transparency-log/proof/:seq', (req, res) => {
    try {
      const seq = _toInt(req.params && req.params.seq);
      if (seq === null || Number.isNaN(seq) || seq < 0) return res.status(400).json({ ok: false, error: 'bad_seq' });
      const log = publicLog();
      const proof = log.inclusionProof(seq);
      if (!proof.ok) return res.status(404).json({ ok: false, error: 'not_found', detail: proof.reason });
      const checkpoint = captureCheckpoint();
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        ok: true,
        // RFC 9162 inclusion-proof fields, top-level and self-contained.
        origin: proof.origin,
        leaf_index: proof.leaf_index,
        tree_size: proof.tree_size,
        audit_path: proof.audit_path,
        root_hash: proof.root_hash,
        leaf_hash: proof.leaf_hash,
        // Backward-compatible nested copies.
        proof,
        checkpoint,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'tlog_proof_failed', detail: e && e.message });
    }
  });

  // GET /v1/transparency-log/checkpoints/latest  (current SIGNED tree head)
  r.get('/v1/transparency-log/checkpoints/latest', (req, res) => {
    try {
      const checkpoint = captureCheckpoint();
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, checkpoint });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'tlog_checkpoint_failed', detail: e && e.message });
    }
  });

  // GET /v1/transparency-log/checkpoints?from&to  (history of signed heads)
  r.get('/v1/transparency-log/checkpoints', (req, res) => {
    try {
      // Always ensure the CURRENT head is captured so the history includes "now".
      captureCheckpoint();
      const q = req.query || {};
      const from = q.from != null && q.from !== '' ? Number(q.from) : null;
      const to = q.to != null && q.to !== '' ? Number(q.to) : null;
      const checkpoints = loadCheckpoints(_storeAdapter, { origin: PUBLIC_ORIGIN, from, to });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, origin: PUBLIC_ORIGIN, count: checkpoints.length, checkpoints });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'tlog_checkpoints_failed', detail: e && e.message });
    }
  });

  return r;
}

export default register;

export const TRANSPARENCY_LOG_ROUTES_SPEC = {
  version: TRANSPARENCY_LOG_ROUTES_VERSION,
  origin: PUBLIC_ORIGIN,
  routes: [
    'GET /v1/transparency-log/size (public)',
    'GET /v1/transparency-log/entries (public)',
    'GET /v1/transparency-log/entries/:seq (public)',
    'GET /v1/transparency-log/proof/:seq (public)',
    'GET /v1/transparency-log/checkpoints/latest (public)',
    'GET /v1/transparency-log/checkpoints (public)',
  ],
};
