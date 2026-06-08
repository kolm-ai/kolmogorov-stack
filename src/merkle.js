// src/merkle.js
//
// W921 Phase-1 - RFC 6962 / RFC 9162 Merkle tree primitives.
//
// These are the shared, dependency-free building blocks for transparency-log
// receipt anchoring (src/receipt-anchor.js) AND for fixing the existing
// artifact-level inclusion-proof verifier in src/sigstore.js, which today
// hand-rolls an index%2 walk with a broken lone-right-edge branch and a root
// compare that truncates non-32-byte roots (sigstore.js:441-468). A
// load-bearing verifier that false-accepts launders trust, so this module
// implements the EXACT RFC 9162 §2.1.3.2 fn/sn/LSB algorithm and a plain
// length-checked timingSafeEqual root compare.
//
// MATH (RFC 6962 §2.1, primary source):
//   leaf:  MTH({d})  = SHA256(0x00 || d)
//   node:  MTH(D[n]) = SHA256(0x01 || MTH(D[0:k]) || MTH(D[k:n]))
//          where k is the largest power of two strictly less than n.
//   empty: MTH({})   = SHA256()   (the hash of the empty string)
//
// RFC 9162 §2.1.3.2 verify_inclusion(hash, m, n, path, root):
//   if m >= n: fail
//   fn := m; sn := n - 1; r := hash
//   for p in path:
//     if sn == 0: fail
//     if LSB(fn) set OR fn == sn:
//        r := SHA256(0x01 || p || r)
//        if LSB(fn) not set: repeat { fn >>= 1; sn >>= 1 } until LSB(fn) set or fn == 0
//     else:
//        r := SHA256(0x01 || r || p)
//     fn >>= 1; sn >>= 1
//   return sn == 0 AND r == root.
//
// This module is a leaf in the import graph: it imports ONLY node:crypto.
// No circular imports. The C/Rust SDK verifiers can port it line-for-line.

import crypto from 'node:crypto';

// RFC 6962 domain-separation prefixes. Exported so test vectors can assert the
// exact bytes (0x00 leaf, 0x01 node) without re-deriving them.
export const LEAF_PREFIX = 0x00;
export const NODE_PREFIX = 0x01;

function sha256(...bufs) {
  const h = crypto.createHash('sha256');
  for (const b of bufs) h.update(b);
  return h.digest();
}

function toBuf(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw new TypeError('merkle: expected Buffer | Uint8Array | string');
}

// ---------------------------------------------------------------------------
// RFC 6962 leaf hash: SHA256(0x00 || data).
// `data` is the raw record bytes (NOT a pre-hash). Accepts Buffer or string.
// ---------------------------------------------------------------------------
export function leafHash(data) {
  return sha256(Buffer.from([LEAF_PREFIX]), toBuf(data));
}

// ---------------------------------------------------------------------------
// RFC 6962 interior node hash: SHA256(0x01 || left || right).
// Inputs MUST already be 32-byte SHA-256 digests (leaf or node hashes).
// ---------------------------------------------------------------------------
export function nodeHash(left, right) {
  const l = toBuf(left);
  const r = toBuf(right);
  return sha256(Buffer.from([NODE_PREFIX]), l, r);
}

// Largest power of two STRICTLY less than n (n >= 2). RFC 6962 split point.
function largestPow2LessThan(n) {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

// ---------------------------------------------------------------------------
// RFC 6962 Merkle Tree Hash (MTH) over an ordered list of leaf hashes.
//
// `leaves` is an array of 32-byte leaf hashes (the output of leafHash). For
// convenience, raw Buffers/strings are coerced through toBuf but are assumed
// to already be leaf hashes - callers wanting record bytes hashed should map
// leafHash over their records first (see buildTree / hashLeaves).
//
//   MTH({})   = SHA256()           (empty tree = hash of empty input)
//   MTH({d0}) = d0                  (single leaf: the leaf hash itself)
//   MTH(D[n]) = nodeHash(MTH(D[0:k]), MTH(D[k:n])), k = largest 2^x < n
// ---------------------------------------------------------------------------
export function computeRoot(leaves) {
  if (!Array.isArray(leaves)) throw new TypeError('merkle.computeRoot: leaves must be an array');
  const n = leaves.length;
  if (n === 0) return sha256(Buffer.alloc(0)); // MTH({}) = SHA256("")
  if (n === 1) return toBuf(leaves[0]);
  const k = largestPow2LessThan(n);
  const left = computeRoot(leaves.slice(0, k));
  const right = computeRoot(leaves.slice(k));
  return nodeHash(left, right);
}

// ---------------------------------------------------------------------------
// RFC 6962 audit (inclusion) path for the leaf at `index` in a tree of the
// given leaves. Returns an array of 32-byte sibling hashes, ordered from the
// leaf level up to (but excluding) the root - exactly what verifyInclusion
// consumes. PATH(m, D[n]) per RFC 6962 §2.1.1:
//   PATH(m, D[1]) = {}
//   for n > 1, k = largest 2^x < n:
//     if m < k: PATH(m, D[0:k]) : MTH(D[k:n])
//     else:     PATH(m-k, D[k:n]) : MTH(D[0:k])
// ---------------------------------------------------------------------------
export function inclusionPath(leaves, index) {
  if (!Array.isArray(leaves)) throw new TypeError('merkle.inclusionPath: leaves must be an array');
  const n = leaves.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new RangeError(`merkle.inclusionPath: index ${index} out of range for tree size ${n}`);
  }
  const path = [];
  function walk(m, subtree) {
    if (subtree.length === 1) return; // leaf reached; no more siblings
    const k = largestPow2LessThan(subtree.length);
    if (m < k) {
      walk(m, subtree.slice(0, k));
      path.push(computeRoot(subtree.slice(k)));
    } else {
      walk(m - k, subtree.slice(k));
      path.push(computeRoot(subtree.slice(0, k)));
    }
  }
  walk(index, leaves);
  return path;
}

// ---------------------------------------------------------------------------
// RFC 9162 §2.1.3.2 verify_inclusion. Pure SHA-256, no network. Returns
// { ok, reason?, root? } where `root` is the hex of the recomputed root on
// success (handy for diagnostics). NEVER throws - bad input returns ok:false.
//
// Args:
//   leafHash - 32-byte leaf hash (Buffer|Uint8Array|hex string)
//   leafIndex (m) - 0-based position of the leaf
//   treeSize  (n) - number of leaves in the tree
//   inclusionPath - array of 32-byte sibling hashes (Buffer|Uint8Array|hex)
//   root - expected Merkle root (Buffer|Uint8Array|hex string)
// ---------------------------------------------------------------------------
export function verifyInclusion({ leafHash, leafIndex, treeSize, inclusionPath, root }) {
  let leaf, rootBuf, path;
  try {
    leaf = coerceDigest(leafHash, 'leafHash');
    rootBuf = coerceDigest(root, 'root');
    if (!Array.isArray(inclusionPath)) return { ok: false, reason: 'inclusionPath must be an array' };
    path = inclusionPath.map((p, i) => coerceDigest(p, `inclusionPath[${i}]`));
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const m = Number(leafIndex);
  const n = Number(treeSize);
  if (!Number.isInteger(m) || m < 0) return { ok: false, reason: 'leafIndex must be a non-negative integer' };
  if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: 'treeSize must be a positive integer' };
  if (m >= n) return { ok: false, reason: `leafIndex ${m} >= treeSize ${n}` };

  // Expected path length = number of set bits + leading-zero structure of the
  // RFC walk. We let the algorithm itself detect over/under-long paths via the
  // sn==0 fail and the final sn==0 check, but we also guard the obvious case.
  let fn = m;
  let sn = n - 1;
  let r = leaf;
  for (const p of path) {
    if (sn === 0) return { ok: false, reason: 'inclusion path longer than tree depth' };
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) {
        // fn is even and fn === sn: shift right until LSB set or fn reaches 0.
        do { fn >>>= 1; sn >>>= 1; } while ((fn & 1) === 0 && fn !== 0);
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>>= 1;
    sn >>>= 1;
  }
  if (sn !== 0) return { ok: false, reason: 'inclusion path shorter than tree depth' };
  if (r.length !== rootBuf.length || !crypto.timingSafeEqual(r, rootBuf)) {
    return {
      ok: false,
      reason: `recomputed root ${r.toString('hex').slice(0, 12)}… != claimed ${rootBuf.toString('hex').slice(0, 12)}…`,
    };
  }
  return { ok: true, root: r.toString('hex') };
}

// Coerce a digest-like input to a Buffer. Accepts Buffer, Uint8Array, or a
// hex/base64 string (hex preferred; base64 fallback for compatibility with
// checkpoint/Rekor encodings). Throws on garbage so verifyInclusion can map
// it to a clean ok:false.
function coerceDigest(v, label) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') {
    if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) return Buffer.from(v, 'hex');
    const b64 = Buffer.from(v, 'base64');
    if (b64.length > 0) return b64;
  }
  throw new TypeError(`merkle: ${label} must be Buffer | Uint8Array | hex/base64 string`);
}

// ---------------------------------------------------------------------------
// Convenience: hash an array of raw records into leaf hashes.
// ---------------------------------------------------------------------------
export function hashLeaves(records) {
  if (!Array.isArray(records)) throw new TypeError('merkle.hashLeaves: records must be an array');
  return records.map(leafHash);
}

// ---------------------------------------------------------------------------
// Convenience tree builder (the task-named API): buildTree(records) builds the
// whole tree from RAW records (each record is leafHash'd first), exposing the
// root and an O(log n) proof per index.
//
// Returns:
//   {
//     size,                     // number of leaves
//     leaves: Buffer[],         // the leaf hashes (post leafHash)
//     root: Buffer,             // RFC 6962 MTH
//     rootHex: string,
//     proof(index) -> { leafHash, leafIndex, treeSize, inclusionPath, root },
//     verifyProof(proof) -> { ok, reason? },
//   }
//
// `records` may be raw bytes/strings, OR { leafHash } if you have already
// hashed (pass { preHashed: true }).
// ---------------------------------------------------------------------------
export function buildTree(records, opts = {}) {
  if (!Array.isArray(records)) throw new TypeError('merkle.buildTree: records must be an array');
  const leaves = opts.preHashed
    ? records.map((r) => coerceDigest(r, 'pre-hashed leaf'))
    : records.map(leafHash);
  const rootBuf = computeRoot(leaves);
  const tree = {
    size: leaves.length,
    leaves,
    root: rootBuf,
    rootHex: rootBuf.toString('hex'),
    proof(index) {
      const path = inclusionPath(leaves, index);
      return {
        leafHash: leaves[index],
        leafIndex: index,
        treeSize: leaves.length,
        inclusionPath: path,
        root: rootBuf,
      };
    },
    verifyProof(proof) {
      return verifyInclusion(proof);
    },
  };
  return tree;
}

// Task-named thin aliases over the RFC primitives (so callers can use the
// terse names from the W921 task brief: root / proof / verifyProof).
export function root(leaves, opts = {}) {
  const ls = opts.preHashed ? leaves.map((l) => coerceDigest(l, 'leaf')) : leaves.map(leafHash);
  return computeRoot(ls);
}

export function proof(leaves, index, opts = {}) {
  const ls = opts.preHashed ? leaves.map((l) => coerceDigest(l, 'leaf')) : leaves.map(leafHash);
  return {
    leafHash: ls[index],
    leafIndex: index,
    treeSize: ls.length,
    inclusionPath: inclusionPath(ls, index),
    root: computeRoot(ls),
  };
}

export function verifyProof(p) {
  return verifyInclusion(p);
}

export const MERKLE_SPEC = {
  rfc: ['6962', '9162'],
  leaf_prefix: LEAF_PREFIX,
  node_prefix: NODE_PREFIX,
  hash: 'sha256',
};
