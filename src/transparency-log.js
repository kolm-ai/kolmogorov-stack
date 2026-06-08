// src/transparency-log.js
//
// W921 Govern / Receipts & Compliance - append-only, verifiable, tamper-evident
// transparency log.
//
// WHAT THIS IS
//   A pure, dependency-free, in-process append-only log whose integrity is
//   provable two independent ways:
//     1) HASH CHAIN (tamper-evident): every entry stores
//        prev_hash + entry_hash = SHA256(prev_hash || canonical(entry_body)).
//        Mutating any historical entry breaks the chain at the first edit, just
//        like src/audit.js - but here the chain is Ed25519-attestable, not
//        HMAC-secret-gated, so a third party can verify it WITHOUT kolm's
//        secret.
//     2) MERKLE ROOT (RFC 6962 / RFC 9162): the whole log (or any consistent
//        prefix) hashes to a single Merkle Tree Head over RFC 6962 leaf hashes
//        of the canonical entry bodies. Any entry has an O(log n) inclusion
//        proof that verifies offline against a signed Tree Head - the exact
//        Certificate-Transparency / Sigstore-Rekor witness model.
//
//   The two together give "an append-only public witness recorded entry E at
//   sequence S, and you can prove inclusion offline" without trusting kolm as
//   the sole root.
//
// WHY NOT EDIT src/audit.js
//   audit.js is an HMAC chain keyed by a server-side secret (verifier needs the
//   secret). This module is the PUBLIC, Ed25519-signed, Merkle-witnessed
//   sibling: same append-only discipline, but offline-verifiable by anyone with
//   the log's public key. It is purely additive and owns its own collection.
//
// REUSE: src/merkle.js (RFC 6962/9162 primitives - never re-implemented here),
//        src/ed25519.js (sign/verify/keyFingerprint), node:crypto.
//
// This module is a leaf in the import graph (merkle.js + ed25519.js + crypto).

import crypto from 'node:crypto';
import {
  leafHash,
  computeRoot,
  inclusionPath,
  verifyInclusion,
} from './merkle.js';
import { sign as ed25519Sign, verify as ed25519Verify, keyFingerprint } from './ed25519.js';

export const TRANSPARENCY_LOG_VERSION = 'w921-tlog-v1';
export const TLOG_CHAIN_ALG = 'sha256';
// Origin label embedded in the signed Tree Head note (C2SP signed-note style:
// a schemaless origin identifies WHICH log a checkpoint belongs to).
export const TLOG_DEFAULT_ORIGIN = 'kolm.ai/transparency/v1';

const ZERO_HASH_HEX = '0'.repeat(64);

function sha256hex(...parts) {
  const h = crypto.createHash(TLOG_CHAIN_ALG);
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Canonical JSON for an entry body. Sorted keys at every level so two callers
// emitting the same logical entry produce byte-identical bytes (the chain and
// the Merkle leaf must be reproducible by any replicator / SDK port).
//
// Self-contained (no import of src/cid.js) to keep this a strict leaf module.
// ---------------------------------------------------------------------------
export function canonicalEntryJson(body) {
  const seen = new WeakSet();
  const norm = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return null; // break cycles defensively
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const val = norm(v[k]);
      if (val !== undefined) out[k] = val;
    }
    return out;
  };
  return JSON.stringify(norm(body));
}

// The canonical bytes that BOTH the chain hash and the RFC 6962 leaf hash are
// computed over. Excludes server-assigned envelope fields (seq/prev_hash/
// entry_hash/leaf_hash) so the body is reproducible by the caller.
function entryBodyBytes(entry) {
  const body = {
    namespace: entry.namespace,
    kind: entry.kind,
    at: entry.at,
    data: entry.data === undefined ? null : entry.data,
  };
  return Buffer.from(canonicalEntryJson(body), 'utf8');
}

// ---------------------------------------------------------------------------
// TransparencyLog - an append-only log instance.
//
// Storage is pluggable: pass a `store` with insert/find (kolm's src/store.js
// shape) to persist, OR omit it for a pure in-memory log (tests / dry-run).
// Tenant-fenced: every row carries tenant_id and reads re-filter by it.
// ---------------------------------------------------------------------------
export class TransparencyLog {
  constructor(opts = {}) {
    this.origin = String(opts.origin || TLOG_DEFAULT_ORIGIN);
    this.tenant_id = opts.tenant_id || null;
    this.collection = String(opts.collection || 'transparency_log');
    this.store = opts.store || null;
    // In-memory fallback when no store is supplied.
    this._mem = [];
  }

  _rows() {
    if (this.store && typeof this.store.find === 'function') {
      const rows = this.store.find(this.collection, (r) =>
        (!this.tenant_id || r.tenant_id === this.tenant_id) && r.origin === this.origin);
      return rows.slice().sort((a, b) => (a.seq | 0) - (b.seq | 0));
    }
    return this._mem
      .filter((r) => (!this.tenant_id || r.tenant_id === this.tenant_id) && r.origin === this.origin)
      .slice()
      .sort((a, b) => (a.seq | 0) - (b.seq | 0));
  }

  size() {
    return this._rows().length;
  }

  // -------------------------------------------------------------------------
  // append(kind, data) -> entry row {seq, prev_hash, entry_hash, leaf_hash, ...}
  //
  // Atomic-ish: computes seq = current size, links prev_hash to the last
  // entry's entry_hash, computes entry_hash + RFC 6962 leaf_hash, persists.
  // NEVER throws on a malformed `data` (it is canonicalized defensively).
  // -------------------------------------------------------------------------
  append(kind, data, opts = {}) {
    const rows = this._rows();
    const seq = rows.length;
    const prev_hash = seq === 0 ? ZERO_HASH_HEX : rows[seq - 1].entry_hash;
    const at = opts.at || new Date().toISOString();
    const namespace = String(opts.namespace || 'default');
    const bodyBytes = entryBodyBytes({ namespace, kind: String(kind), at, data });
    const canonical = bodyBytes.toString('utf8');
    const entry_hash = sha256hex(Buffer.from(`${prev_hash}|`, 'utf8'), bodyBytes);
    const leaf_hash = leafHash(bodyBytes).toString('hex'); // RFC 6962 SHA256(0x00||body)
    const row = {
      origin: this.origin,
      tenant_id: this.tenant_id || (opts.tenant_id || null),
      seq,
      kind: String(kind),
      namespace,
      at,
      data: data === undefined ? null : data,
      canonical,
      prev_hash,
      entry_hash,
      leaf_hash,
      version: TRANSPARENCY_LOG_VERSION,
    };
    if (this.store && typeof this.store.insert === 'function') {
      this.store.insert(this.collection, row);
    } else {
      this._mem.push(row);
    }
    return row;
  }

  // Recompute the RFC 6962 Merkle Tree Head over all current leaf hashes.
  treeHead() {
    const rows = this._rows();
    const leaves = rows.map((r) => Buffer.from(r.leaf_hash, 'hex'));
    const rootBuf = computeRoot(leaves);
    return {
      origin: this.origin,
      tree_size: rows.length,
      root_hash: rootBuf.toString('hex'),
      root_b64: rootBuf.toString('base64'),
    };
  }

  // -------------------------------------------------------------------------
  // inclusionProof(seq) -> { ok, leaf_hash, leaf_index, tree_size, audit_path[],
  //                          root_hash } | { ok:false, reason }
  //
  // O(log n) RFC 6962 audit path for the entry at `seq`, plus the Tree Head it
  // proves into. The returned proof verifies offline via verifyInclusionProof.
  // -------------------------------------------------------------------------
  inclusionProof(seq) {
    const rows = this._rows();
    const n = rows.length;
    if (!Number.isInteger(seq) || seq < 0 || seq >= n) {
      return { ok: false, reason: `seq ${seq} out of range for tree size ${n}` };
    }
    const leaves = rows.map((r) => Buffer.from(r.leaf_hash, 'hex'));
    const path = inclusionPath(leaves, seq);
    const rootBuf = computeRoot(leaves);
    return {
      ok: true,
      origin: this.origin,
      leaf_hash: rows[seq].leaf_hash,
      leaf_index: seq,
      tree_size: n,
      audit_path: path.map((p) => p.toString('hex')),
      root_hash: rootBuf.toString('hex'),
    };
  }

  // -------------------------------------------------------------------------
  // verifyChain() -> { ok, total, breaks[], last_hash }
  //
  // Walk the hash chain, recompute prev/entry hashes from the canonical bodies,
  // report any break. This needs NO secret - it is pure SHA-256 over public
  // bytes (unlike the HMAC audit chain in src/audit.js).
  // -------------------------------------------------------------------------
  verifyChain() {
    const rows = this._rows();
    if (!rows.length) return { ok: true, total: 0, breaks: [], last_hash: ZERO_HASH_HEX };
    let prev = ZERO_HASH_HEX;
    const breaks = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const bodyBytes = entryBodyBytes(r);
      const expectedEntry = sha256hex(Buffer.from(`${prev}|`, 'utf8'), bodyBytes);
      const expectedLeaf = leafHash(bodyBytes).toString('hex');
      if (r.prev_hash !== prev) {
        breaks.push({ seq: r.seq, reason: 'prev_hash_mismatch', expected_prev: prev, got_prev: r.prev_hash });
      }
      if (r.entry_hash !== expectedEntry) {
        breaks.push({ seq: r.seq, reason: 'entry_hash_mismatch', expected: expectedEntry, got: r.entry_hash });
      }
      if (r.leaf_hash !== expectedLeaf) {
        breaks.push({ seq: r.seq, reason: 'leaf_hash_mismatch', expected: expectedLeaf, got: r.leaf_hash });
      }
      prev = r.entry_hash;
    }
    return { ok: breaks.length === 0, total: rows.length, breaks, last_hash: prev };
  }

  // Materialize the whole log + a signed Tree Head (if a signer is given).
  export(opts = {}) {
    const rows = this._rows();
    const head = this.treeHead();
    let signed_tree_head = null;
    if (opts.signer && opts.signer.privateKey) {
      signed_tree_head = signTreeHead(head, opts.signer);
    }
    return {
      ok: true,
      version: TRANSPARENCY_LOG_VERSION,
      origin: this.origin,
      tree_head: head,
      signed_tree_head,
      chain: this.verifyChain(),
      entries: rows.map((r) => ({
        seq: r.seq,
        kind: r.kind,
        namespace: r.namespace,
        at: r.at,
        prev_hash: r.prev_hash,
        entry_hash: r.entry_hash,
        leaf_hash: r.leaf_hash,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// signTreeHead(head, signer) -> signed checkpoint note (C2SP signed-note style)
//
// note text (>=3 lines):
//   <origin>\n<tree_size>\n<base64(root)>\n
// signed with Ed25519; key_id = first 12 bytes of SHA256(origin || pubkeyDER).
// This mirrors the public-transparency-log checkpoint shape so the SAME
// verifier logic ports across kolm's own log and a future Rekor anchor.
// ---------------------------------------------------------------------------
export function buildCheckpointNote(head) {
  const origin = String(head.origin || TLOG_DEFAULT_ORIGIN);
  const size = Number(head.tree_size) | 0;
  const rootB64 = head.root_b64 || Buffer.from(String(head.root_hash || ''), 'hex').toString('base64');
  // Trailing newline after the body, per C2SP signed-note: body lines each end
  // with \n; the signature lines follow.
  return `${origin}\n${size}\n${rootB64}\n`;
}

export function signTreeHead(head, signer) {
  if (!signer || !signer.privateKey) throw new Error('signTreeHead: signer.privateKey required');
  const note = buildCheckpointNote(head);
  const sigB64Url = ed25519Sign(signer.privateKey, Buffer.from(note, 'utf8'));
  let key_id = signer.key_fingerprint;
  if (!key_id && signer.publicKey) {
    try { key_id = keyFingerprint(signer.publicKey); } catch { key_id = undefined; }
  }
  return {
    note,
    origin: head.origin,
    tree_size: head.tree_size,
    root_hash: head.root_hash,
    root_b64: head.root_b64,
    alg: 'ed25519',
    signature: Buffer.from(sigB64Url, 'base64url').toString('base64'), // STANDARD base64
    public_key: signer.publicKey,
    key_id,
    signed_at: new Date().toISOString(),
    version: TRANSPARENCY_LOG_VERSION,
  };
}

// verifyTreeHeadSignature(signed, pinnedPublicKeyPem?) -> { ok, reason?, key_id? }
// Verifies the Ed25519 checkpoint signature over the note. If a pinned key is
// supplied, the embedded public_key must match it (defeats key-substitution).
export function verifyTreeHeadSignature(signed, pinnedPublicKeyPem = null) {
  if (!signed || typeof signed !== 'object') return { ok: false, reason: 'no_signed_tree_head' };
  const pub = pinnedPublicKeyPem || signed.public_key;
  if (!pub) return { ok: false, reason: 'no_public_key' };
  if (pinnedPublicKeyPem && signed.public_key && signed.public_key.trim() !== pinnedPublicKeyPem.trim()) {
    return { ok: false, reason: 'public_key_mismatch_vs_pinned' };
  }
  if (typeof signed.signature !== 'string' || !signed.note) return { ok: false, reason: 'malformed_signature' };
  let sigB64Url;
  try { sigB64Url = Buffer.from(signed.signature, 'base64').toString('base64url'); }
  catch { return { ok: false, reason: 'signature_decode_failed' }; }
  const ok = ed25519Verify(pub, Buffer.from(signed.note, 'utf8'), sigB64Url);
  if (!ok) return { ok: false, reason: 'signature_does_not_verify' };
  let key_id;
  try { key_id = keyFingerprint(pub); } catch { key_id = undefined; }
  return { ok: true, key_id };
}

// ---------------------------------------------------------------------------
// verifyTransparencyAppend({ before, entry, after }) -> { ok, reason?, ... }
//
// Append-only correctness proof. Given the log state BEFORE an append, the
// entry that was appended, and the state AFTER, confirm:
//   (1) seq is strictly the next index (after.tree_size === before.tree_size+1)
//   (2) the entry links to the prior head (prev_hash === before.last_entry_hash)
//   (3) the new entry's leaf is INCLUDED in the after Tree Head at its seq
//       (RFC 9162 inclusion proof) - i.e. the append is consistent, the log was
//       not silently rewritten.
//
// `before`/`after` are TreeHead-like { tree_size, root_hash, last_entry_hash? }.
// `proof` is an inclusion proof (from inclusionProof) of the new leaf into
// `after`. This is the function the task brief names verbatim.
// ---------------------------------------------------------------------------
export function verifyTransparencyAppend({ before, entry, after, proof }) {
  if (!entry || typeof entry !== 'object') return { ok: false, reason: 'no_entry' };
  if (!after || typeof after !== 'object') return { ok: false, reason: 'no_after_head' };
  const beforeSize = before && Number.isInteger(before.tree_size) ? before.tree_size : 0;
  const afterSize = Number(after.tree_size);
  const appended_at_end = afterSize === beforeSize + 1;
  if (!appended_at_end) {
    return { ok: false, reason: `tree grew by ${afterSize - beforeSize}, expected exactly 1`, appended_at_end: false };
  }
  // (1) seq must be the prior size.
  if (Number(entry.seq) !== beforeSize) {
    return { ok: false, reason: `entry.seq ${entry.seq} !== expected ${beforeSize}`, appended_at_end };
  }
  // (2) prev_hash links to the prior head's last entry hash, when known.
  let prev_linked = true;
  if (before && before.last_entry_hash) {
    prev_linked = entry.prev_hash === before.last_entry_hash;
  } else if (beforeSize === 0) {
    prev_linked = entry.prev_hash === ZERO_HASH_HEX;
  }
  if (!prev_linked) {
    return { ok: false, reason: 'prev_hash does not link to prior head', appended_at_end, prev_linked };
  }
  // (3) inclusion of the new leaf in the after-root.
  let included = false;
  if (proof && proof.ok !== false) {
    const inc = verifyInclusion({
      leafHash: proof.leaf_hash || entry.leaf_hash,
      leafIndex: proof.leaf_index != null ? proof.leaf_index : entry.seq,
      treeSize: proof.tree_size != null ? proof.tree_size : afterSize,
      inclusionPath: proof.audit_path || [],
      root: after.root_hash,
    });
    included = inc.ok;
    if (!included) {
      return { ok: false, reason: `inclusion failed: ${inc.reason}`, appended_at_end, prev_linked, included };
    }
  }
  return { ok: true, appended_at_end, prev_linked, included, seq: entry.seq };
}

// ---------------------------------------------------------------------------
// verifyInclusionProof(proof, opts?) -> { ok, reason?, root?, checkpoint? }
//
// Stand-alone, fully OFFLINE verification of a single inclusion proof - the
// shape returned by TransparencyLog#inclusionProof(seq):
//   { leaf_hash, leaf_index, tree_size, audit_path[hex...], root_hash }
//
// This is the function a browser widget or an SDK port calls to confirm
// "entry E really is in the log committed by root R" WITHOUT trusting kolm:
// it is pure RFC 9162 SHA-256 over the supplied bytes. No network, no secret.
//
// opts.signedTreeHead (optional): a signed checkpoint (from signTreeHead). When
//   supplied, the proof's root_hash AND tree_size must match the checkpoint,
//   and the checkpoint's Ed25519 signature must verify - so a single call
//   answers "is E in the log, and is that log state signed by the operator?".
// opts.pinnedPublicKeyPem (optional): pin the checkpoint key (defeats key
//   substitution); forwarded to verifyTreeHeadSignature.
//
// Accepts both snake_case (server/JSON shape) and camelCase (merkle.js shape)
// field names so it is forgiving to either caller. NEVER throws.
// ---------------------------------------------------------------------------
export function verifyInclusionProof(proof, opts = {}) {
  if (!proof || typeof proof !== 'object') return { ok: false, reason: 'no_proof' };
  if (proof.ok === false) return { ok: false, reason: proof.reason || 'proof_marked_not_ok' };

  const leaf_hash = proof.leaf_hash ?? proof.leafHash;
  const leaf_index = proof.leaf_index ?? proof.leafIndex;
  const tree_size = proof.tree_size ?? proof.treeSize;
  const audit_path = proof.audit_path ?? proof.inclusionPath ?? proof.path;
  const root_hash = proof.root_hash ?? proof.root;

  if (leaf_hash == null) return { ok: false, reason: 'missing leaf_hash' };
  if (root_hash == null) return { ok: false, reason: 'missing root_hash' };
  if (!Array.isArray(audit_path)) return { ok: false, reason: 'missing/!array audit_path' };

  // If a signed checkpoint is supplied, bind the proof to it BEFORE the math:
  // the root we verify into must be the signed one, not a root the caller
  // pulled from the same untrusted source as the proof.
  let checkpoint;
  if (opts.signedTreeHead) {
    const sth = opts.signedTreeHead;
    const sthRoot = sth.root_hash || (sth.root_b64 ? Buffer.from(sth.root_b64, 'base64').toString('hex') : null);
    if (sthRoot && String(sthRoot).toLowerCase() !== String(root_hash).toLowerCase()) {
      return { ok: false, reason: 'proof root_hash != signed checkpoint root_hash' };
    }
    if (sth.tree_size != null && Number(sth.tree_size) !== Number(tree_size)) {
      return { ok: false, reason: `proof tree_size ${tree_size} != checkpoint tree_size ${sth.tree_size}` };
    }
    const sig = verifyTreeHeadSignature(sth, opts.pinnedPublicKeyPem || null);
    if (!sig.ok) return { ok: false, reason: `checkpoint signature: ${sig.reason}` };
    checkpoint = { verified: true, key_id: sig.key_id, tree_size: sth.tree_size, root_hash: sthRoot };
  }

  const inc = verifyInclusion({
    leafHash: leaf_hash,
    leafIndex: leaf_index,
    treeSize: tree_size,
    inclusionPath: audit_path,
    root: root_hash,
  });
  if (!inc.ok) return { ok: false, reason: inc.reason, checkpoint };
  return { ok: true, root: inc.root, leaf_index, tree_size, checkpoint };
}

// ---------------------------------------------------------------------------
// Module-level convenience: a process-wide default log (used by routes when no
// explicit log is injected). Keyed by `${tenant}:${origin}` so callers reusing
// the same tenant/origin share one append-only instance.
// ---------------------------------------------------------------------------
const _defaultLogs = new Map();

export function getTransparencyLog({ tenant_id = null, origin = TLOG_DEFAULT_ORIGIN, store = null } = {}) {
  const key = `${tenant_id || '_'}::${origin}`;
  let log = _defaultLogs.get(key);
  if (!log) {
    log = new TransparencyLog({ tenant_id, origin, store });
    _defaultLogs.set(key, log);
  } else if (store && !log.store) {
    log.store = store;
  }
  return log;
}

// For tests: clear the module-level default-log cache.
export function _resetTransparencyLogsForTests() {
  _defaultLogs.clear();
}

export const TRANSPARENCY_LOG_SPEC = {
  version: TRANSPARENCY_LOG_VERSION,
  chain_alg: TLOG_CHAIN_ALG,
  merkle: 'RFC 6962 / RFC 9162',
  checkpoint: 'C2SP signed-note (Ed25519)',
  origin: TLOG_DEFAULT_ORIGIN,
};
