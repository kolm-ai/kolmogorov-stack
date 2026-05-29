// src/transparency-anchor.js
//
// W921 Govern / Receipts & Compliance — Merkle-tree BATCH anchoring of per-call
// receipts + tamper-evident receipt chains + two-level offline inclusion proofs.
//
// PROBLEM (from the Sigstore/Rekor spec): a per-call gateway receipt today is
// only as trustworthy as kolm's private-key custody — a host compromise can
// mint a key and forge a "verified" receipt after the fact, and nobody can
// prove a receipt EXISTED at time T. Anchoring each receipt to a transparency
// log 1:1 is wrong: public logs batch writes and take seconds per entry, so
// per-call anchoring would add seconds of latency to every call.
//
// CORRECT DESIGN — CLIENT-SIDE MERKLE BATCHING + SINGLE ROOT ANCHOR:
//   HOT PATH (unchanged latency): compute the receipt's RFC 6962 leaf hash and
//     enqueue (leaf, receipt_id). No network. ~one sha256, microseconds.
//   BATCHER (off hot path): drain the queue on a timer/size trigger, build ONE
//     RFC 6962 Merkle tree over the window of leaves -> batch_root, with an
//     O(log n) audit path per leaf.
//   ANCHOR (one network call per BATCH): sign batch_root + (optionally) submit
//     ONE transparency-log entry per batch. On any failure degrade to
//     state:'local' + retry — anchoring NEVER blocks/fails a served call.
//   STAMP-BACK: each receipt gains an `anchor` block {batch_id, leaf_index,
//     audit_path, batch_root, checkpoint} OUTSIDE the signed canonical body.
//   VERIFY (offline, no kolm trust): LEVEL A recompute leaf -> walk audit_path
//     -> compare to batch_root (RFC 9162 verify_inclusion of receipt in batch).
//     LEVEL B verify the signed checkpoint over batch_root against a pinned key.
//
// This module owns the ANCHORING orchestration; it REUSES src/merkle.js for all
// RFC 6962/9162 math and src/transparency-log.js for the signed Tree Head. It
// is build-/background-time only and never sits on the served gateway path
// (the router would only call enqueueReceipt, which is non-blocking).
//
// ZERO new dependencies: node:crypto + merkle.js + ed25519.js + transparency-log.js.

import crypto from 'node:crypto';
import {
  leafHash,
  buildTree,
  verifyInclusion,
} from './merkle.js';
import {
  signTreeHead,
  verifyTreeHeadSignature,
  buildCheckpointNote,
} from './transparency-log.js';

export const RECEIPT_ANCHOR_VERSION = 'w921-anchor-v1';
export const DEFAULT_BATCH_INTERVAL_MS = 60000;
export const DEFAULT_BATCH_MAX = 1024;
// Hard ceiling so a runaway producer cannot exhaust memory on the hot path.
export const ENQUEUE_QUEUE_CAP = 65536;

// ---------------------------------------------------------------------------
// anchorLeafHash(receipt) -> Buffer (RFC 6962 leaf over the receipt body)
//
// Computes the leaf hash over a canonical serialization of the receipt body
// MINUS any existing `anchor` block (the anchor lives outside the signed body,
// so including it would make the leaf un-recomputable post-stamp). Stable
// across re-serialization: sorted keys at every level.
// ---------------------------------------------------------------------------
function canonicalReceiptJson(receipt) {
  const seen = new WeakSet();
  const norm = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === 'anchor') continue; // anchor is NON-signed, excluded from the leaf
      const val = norm(v[k]);
      if (val !== undefined) out[k] = val;
    }
    return out;
  };
  return JSON.stringify(norm(v_in(receipt)));
}
function v_in(r) { return r && typeof r === 'object' ? r : {}; }

export function anchorLeafHash(receipt) {
  const bytes = Buffer.from(canonicalReceiptJson(receipt), 'utf8');
  return leafHash(bytes);
}

// ---------------------------------------------------------------------------
// governReceiptBatch(receipts, opts) -> { merkle_root, leaves, inclusion_proofs }
//
// The task-named headline function. Given an array of receipts (or pre-computed
// leaf hashes), build the batch Merkle tree and return the root, the leaf
// hashes, and a verifiable inclusion proof for EVERY receipt. Pure, synchronous,
// no network. This is the unit the batcher anchors.
//
// `receipts` may be:
//   - signed receipt objects (leaf computed via anchorLeafHash), OR
//   - { receipt_id, leaf } / { receipt_id, leafHash } entries, OR
//   - raw 32-byte Buffers / hex strings (treated as pre-hashed leaves).
// ---------------------------------------------------------------------------
export function governReceiptBatch(receipts, opts = {}) {
  if (!Array.isArray(receipts)) {
    throw new TypeError('governReceiptBatch: receipts must be an array');
  }
  const ids = [];
  const leafBufs = receipts.map((r, i) => {
    if (Buffer.isBuffer(r)) { ids.push(opts.idAt ? opts.idAt(i) : null); return r; }
    if (typeof r === 'string') {
      ids.push(opts.idAt ? opts.idAt(i) : null);
      return Buffer.from(r, 'hex');
    }
    if (r && (r.leaf || r.leafHash)) {
      ids.push(r.receipt_id || r.id || null);
      const lf = r.leaf || r.leafHash;
      return Buffer.isBuffer(lf) ? lf : Buffer.from(String(lf), 'hex');
    }
    // Otherwise treat as a receipt object.
    ids.push((r && (r.receipt_id || (r.receipt && r.receipt.receipt_id))) || null);
    return anchorLeafHash(r && r.receipt ? r.receipt : r);
  });

  const batch_id = opts.batch_id || ('batch_' + crypto.randomBytes(8).toString('hex'));
  const tree = buildTree(leafBufs, { preHashed: true });
  const inclusion_proofs = leafBufs.map((_, i) => {
    const p = tree.proof(i);
    return {
      receipt_id: ids[i],
      leaf_index: i,
      tree_size: tree.size,
      leaf_hash: tree.leaves[i].toString('hex'),
      audit_path: p.inclusionPath.map((h) => h.toString('hex')),
      batch_root: tree.rootHex,
    };
  });

  return {
    ok: true,
    version: RECEIPT_ANCHOR_VERSION,
    batch_id,
    tree_size: tree.size,
    merkle_root: tree.rootHex,
    merkle_root_b64: tree.root.toString('base64'),
    leaves: tree.leaves.map((l) => l.toString('hex')),
    inclusion_proofs,
    receipt_ids: ids,
  };
}

// ---------------------------------------------------------------------------
// anchorBatch(batch, { signer, submitFn, timeoutMs }) -> { state, checkpoint?, log? }
//
// Sign the batch root as a Tree Head checkpoint, and (optionally) submit ONE
// transparency-log entry per batch via an injected submitFn (e.g. a Rekor v2
// client). On any failure OR when no submitFn is configured, degrade to
// state:'local' with the kolm-signed checkpoint — NEVER throws, NEVER blocks a
// served call.
// ---------------------------------------------------------------------------
export async function anchorBatch(batch, opts = {}) {
  if (!batch || !batch.merkle_root) {
    return { state: 'error', reason: 'no_batch_root' };
  }
  const head = {
    origin: opts.origin || 'kolm.ai/receipts/v1',
    tree_size: batch.tree_size,
    root_hash: batch.merkle_root,
    root_b64: batch.merkle_root_b64 || Buffer.from(batch.merkle_root, 'hex').toString('base64'),
  };
  let checkpoint = null;
  if (opts.signer && opts.signer.privateKey) {
    try { checkpoint = signTreeHead(head, opts.signer); } catch { checkpoint = null; }
  }
  // No external log configured -> local witness only.
  if (typeof opts.submitFn !== 'function') {
    return { state: 'local', batch_id: batch.batch_id, checkpoint, log: null };
  }
  // Submit ONE entry for the whole batch. Failure degrades to local.
  try {
    const log = await opts.submitFn({
      digestHex: batch.merkle_root,
      treeSize: batch.tree_size,
      checkpoint,
      timeoutMs: opts.timeoutMs || 20000,
    });
    if (log && (log.logIndex != null || log.log_index != null || log.ok)) {
      return { state: 'anchored', batch_id: batch.batch_id, checkpoint, log };
    }
    return { state: 'local', batch_id: batch.batch_id, checkpoint, log: null, reason: 'submit_no_proof' };
  } catch (e) {
    return { state: 'local', batch_id: batch.batch_id, checkpoint, log: null, reason: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// stampReceiptAnchor(receipt, batch, proof, anchorResult) -> anchor block
//
// Build the NON-signed `anchor` block to attach to an observation row. Stored
// OUTSIDE the canonical signed receipt body so the Ed25519 receipt signature
// stays valid (same pattern as latency_breakdown).
// ---------------------------------------------------------------------------
export function stampReceiptAnchor(proof, anchorResult = {}) {
  if (!proof || proof.ok === false) return null;
  return {
    version: RECEIPT_ANCHOR_VERSION,
    batch_id: proof.batch_id || anchorResult.batch_id || null,
    leaf_index: proof.leaf_index,
    tree_size: proof.tree_size,
    audit_path: proof.audit_path,
    batch_root: proof.batch_root,
    state: anchorResult.state || 'local',
    checkpoint: anchorResult.checkpoint || null,
    rekor: anchorResult.log || null,
    stamped_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// verifyReceiptAnchor({ receipt, anchor, pinnedLogKeyPem }) -> two-level result
//
// LEVEL A: recompute the receipt leaf, walk audit_path, compare to batch_root.
// LEVEL B: verify the signed checkpoint over batch_root against the pinned key.
// Pure SHA-256 + one Ed25519 verify. NO network, NO kolm. Never throws.
// ---------------------------------------------------------------------------
export function verifyReceiptAnchor({ receipt, anchor, pinnedLogKeyPem = null } = {}) {
  if (!anchor || typeof anchor !== 'object') {
    return { ok: false, level_a: { ok: false, reason: 'no_anchor' }, level_b: { ok: false, reason: 'no_anchor' } };
  }
  // LEVEL A — receipt inclusion within the batch.
  const leaf = receipt ? anchorLeafHash(receipt).toString('hex') : anchor.leaf_hash;
  const level_a = verifyInclusion({
    leafHash: leaf,
    leafIndex: anchor.leaf_index,
    treeSize: anchor.tree_size,
    inclusionPath: anchor.audit_path || [],
    root: anchor.batch_root,
  });

  // LEVEL B — checkpoint signature over the batch root.
  let level_b;
  if (!anchor.checkpoint) {
    level_b = { ok: false, reason: 'not_anchored' };
  } else {
    const sigRes = verifyTreeHeadSignature(anchor.checkpoint, pinnedLogKeyPem);
    if (!sigRes.ok) {
      level_b = { ok: false, reason: sigRes.reason };
    } else {
      // The signed checkpoint root must equal the batch root the receipt proves into.
      const cpRoot = anchor.checkpoint.root_hash
        || (anchor.checkpoint.root_b64 ? Buffer.from(anchor.checkpoint.root_b64, 'base64').toString('hex') : null);
      if (cpRoot && cpRoot.toLowerCase() !== String(anchor.batch_root).toLowerCase()) {
        level_b = { ok: false, reason: 'checkpoint_root_mismatch' };
      } else {
        level_b = { ok: true, key_id: sigRes.key_id };
      }
    }
  }

  return {
    ok: level_a.ok && level_b.ok,
    level_a: { ok: level_a.ok, reason: level_a.reason },
    level_b,
    state: anchor.state || (level_b.ok ? 'anchored' : 'local'),
  };
}

// ---------------------------------------------------------------------------
// ReceiptAnchorBatcher — bounded in-process queue + size/timer-triggered
// batcher. Off the hot path; the only hot-path call is enqueue() (non-blocking).
// ---------------------------------------------------------------------------
export class ReceiptAnchorBatcher {
  constructor(opts = {}) {
    this.intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : DEFAULT_BATCH_INTERVAL_MS;
    this.maxLeaves = Number(opts.maxLeaves) > 0 ? Number(opts.maxLeaves) : DEFAULT_BATCH_MAX;
    this.cap = Number(opts.cap) > 0 ? Number(opts.cap) : ENQUEUE_QUEUE_CAP;
    this.signer = opts.signer || null;
    this.submitFn = typeof opts.submitFn === 'function' ? opts.submitFn : null;
    this.origin = opts.origin || 'kolm.ai/receipts/v1';
    this.onBatch = typeof opts.onBatch === 'function' ? opts.onBatch : null;
    this.onError = typeof opts.onError === 'function' ? opts.onError : null;
    this._queue = [];
    this._timer = null;
    this._dropped = 0;
    this._batches = 0;
  }

  // HOT PATH: enqueue (leaf, receipt_id). Bounded, non-blocking, never throws.
  enqueue({ receipt_id, leaf, receipt }) {
    if (this._queue.length >= this.cap) { this._dropped++; return false; }
    let lf = leaf;
    try {
      if (!lf && receipt) lf = anchorLeafHash(receipt);
      if (typeof lf === 'string') lf = Buffer.from(lf, 'hex');
    } catch { this._dropped++; return false; }
    if (!Buffer.isBuffer(lf)) { this._dropped++; return false; }
    this._queue.push({ receipt_id: receipt_id || null, leaf: lf });
    if (this._queue.length >= this.maxLeaves) {
      // size-trigger: flush asynchronously so we never block the caller.
      Promise.resolve().then(() => this.flushNow()).catch((e) => this.onError && this.onError(e));
    }
    return true;
  }

  status() {
    return {
      queued: this._queue.length,
      cap: this.cap,
      max_leaves: this.maxLeaves,
      interval_ms: this.intervalMs,
      dropped: this._dropped,
      batches: this._batches,
      mode: this.submitFn ? 'anchor' : 'local',
      version: RECEIPT_ANCHOR_VERSION,
    };
  }

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => {
      this.flushNow().catch((e) => this.onError && this.onError(e));
    }, this.intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    return this;
  }

  async flushNow() {
    if (this._queue.length === 0) return { ok: true, empty: true };
    const window = this._queue.splice(0, this.maxLeaves);
    this._batches++;
    const batch = governReceiptBatch(window, {
      idAt: (i) => window[i] && window[i].receipt_id,
    });
    const anchorResult = await anchorBatch(batch, {
      signer: this.signer, submitFn: this.submitFn, origin: this.origin,
    });
    const stamps = batch.inclusion_proofs.map((p) => ({
      receipt_id: p.receipt_id,
      anchor: stampReceiptAnchor({ ...p, batch_id: batch.batch_id }, anchorResult),
    }));
    if (this.onBatch) {
      try { this.onBatch({ batch, anchorResult, stamps }); } catch (e) { this.onError && this.onError(e); }
    }
    return { ok: true, batch_id: batch.batch_id, tree_size: batch.tree_size, state: anchorResult.state, stamps };
  }

  async stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    // graceful drain so nothing is silently lost.
    return this.flushNow();
  }
}

export function startBatcher(opts = {}) {
  const b = new ReceiptAnchorBatcher(opts);
  b.start();
  return {
    enqueue: (x) => b.enqueue(x),
    flushNow: () => b.flushNow(),
    status: () => b.status(),
    stop: () => b.stop(),
    _batcher: b,
  };
}

export const RECEIPT_ANCHOR_SPEC = {
  version: RECEIPT_ANCHOR_VERSION,
  merkle: 'RFC 6962 / RFC 9162',
  default_interval_ms: DEFAULT_BATCH_INTERVAL_MS,
  default_batch_max: DEFAULT_BATCH_MAX,
  checkpoint: 'C2SP signed-note (Ed25519)',
};

// Re-export the checkpoint builder so callers can render the note text.
export { buildCheckpointNote };
