// Content-identifier (CID) for .kolm artifacts.
//
// A CID is a deterministic, content-addressed identifier that any verifier
// can recompute from the artifact bytes alone - no server, no registry, no
// authentication. Two artifacts with identical content produce the same CID;
// any byte difference (even a re-zipped file order) produces a different CID.
//
// Format: `cidv1:sha256:<64-hex>` (multiformat-inspired prefix so future
// digest algorithms can be added without breaking back-compat).
//
// CID inputs (canonical sorted-key JSON over the manifest's `hashes` block):
//   - model_pointer - sha256 of model.gguf bytes
//   - recipes_json - sha256 of recipes.json bytes
//   - lora_bin - sha256 of lora.bin bytes
//   - index_bin - sha256 of index.sqlite-vec bytes
//   - evals_json - sha256 of evals.json bytes
//
// The K-score, receipt, and signature are deliberately NOT in the CID. Those
// are the *seal* on the bundle; the CID is the *identity* of the bundle. A
// receipt re-signed with a rotated tenant secret still describes the same
// underlying CID. The artifact_hash on the manifest is a flat sha256 over
// the same inputs; the CID prefixes it for future multi-hash compatibility.
//
// Deduplication: two compile jobs that yield the same CID (same task spec,
// same recipes, same evals, same base model pointer) can be deduped by the
// registry to a single artifact row. The audit log is never deduped - every
// compile remains a distinct event.

import crypto from 'node:crypto';

const CID_VERSION = 'cidv1';
const DEFAULT_DIGEST = 'sha256';
const REQUIRED_PARTS = ['model_pointer', 'recipes_json', 'lora_bin', 'index_bin', 'evals_json'];

export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Compute a CID from a manifest's `hashes` block. Pass the manifest object's
// hashes - not the receipt - so the CID is independent of signing key
// rotation and remains stable across re-seals of identical content.
export function cidFromManifestHashes(hashes) {
  if (!hashes || typeof hashes !== 'object') {
    throw new Error('cidFromManifestHashes: hashes object required');
  }
  for (const k of REQUIRED_PARTS) {
    if (typeof hashes[k] !== 'string' || !/^[0-9a-f]{64}$/.test(hashes[k])) {
      throw new Error(`cidFromManifestHashes: hashes.${k} must be a 64-char hex sha256`);
    }
  }
  const canonical = canonicalJson({
    digest: DEFAULT_DIGEST,
    parts: {
      model_pointer: hashes.model_pointer,
      recipes_json:  hashes.recipes_json,
      lora_bin:      hashes.lora_bin,
      index_bin:     hashes.index_bin,
      evals_json:    hashes.evals_json,
    },
  });
  const digest = sha256Hex(canonical);
  return `${CID_VERSION}:${DEFAULT_DIGEST}:${digest}`;
}

// Verify a CID against a manifest's hashes block - symmetric helper for the
// verifier. Returns true when the CID matches; false otherwise (never throws).
export function verifyCidAgainstManifestHashes(cid, hashes) {
  try {
    return cidFromManifestHashes(hashes) === cid;
  } catch {
    return false;
  }
}

// Parse a CID string into its components. Returns null on malformed input
// so callers can branch without try/catch.
export function parseCid(cid) {
  if (typeof cid !== 'string') return null;
  const m = /^(cidv\d+):([a-z0-9-]+):([0-9a-f]+)$/.exec(cid);
  if (!m) return null;
  return { version: m[1], digest: m[2], hex: m[3] };
}

// Strict-validate a CID format string. True iff the encoding is well-formed
// (independent of whether any underlying content matches).
export function isValidCidFormat(cid) {
  const p = parseCid(cid);
  if (!p) return false;
  if (p.version !== CID_VERSION) return false;
  if (p.digest !== DEFAULT_DIGEST) return false;
  if (p.hex.length !== 64) return false;
  return true;
}

// Short-CID for display: cidv1:sha256:abc123…def456 (first 6 + last 6 hex).
// Useful in CLI tables and dashboards where the full 64-hex digest is noise.
export function shortCid(cid) {
  const p = parseCid(cid);
  if (!p) return cid;
  if (p.hex.length <= 14) return cid;
  return `${p.version}:${p.digest}:${p.hex.slice(0, 6)}…${p.hex.slice(-6)}`;
}

export const CID_SPEC = {
  version: CID_VERSION,
  digest: DEFAULT_DIGEST,
  parts: REQUIRED_PARTS,
};
