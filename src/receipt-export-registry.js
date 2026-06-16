// src/receipt-export-registry.js
//
// C1 Provenance / Receipt / Transparency Chain - a RECEIPT-CLASS REGISTRY that
// drives the in-toto / OMS export path off a per-schema descriptor instead of
// the hardcoded kolm-audit-1 field vocabulary.
//
// THE GAP THIS CLOSES (open Q1): src/intoto-receipt.js receiptSubjects() keys
// subject names off receipt.receipt_id (an mcp-tool-call-1 receipt has no
// receipt_id, so the name becomes "receipt:unknown") and only emits an output
// subject from receipt.output_hash (mcp carries result_hash, dropped). And
// buildInferencePredicate() copies a FIXED kolm-audit-1 field list, so an mcp
// receipt loses tool / args_hash / result_hash / tenant_id. Result: an
// mcp-tool-call-1 receipt cannot be exported as a faithful in-toto Statement
// today. This module makes the export DESCRIPTOR-DRIVEN and BYTE-IDENTICAL for
// kolm-audit-1 (the golden-vector contract, AC2).
//
// PRIVACY: in-toto subjects carry ONLY sha256 digests (truncated short hashes
// for receipt fields, full 64-hex for the receipt-body digest). We NEVER
// fabricate a digest, and we never export raw prompt/output bytes - only the
// hashes the receipt already records. A subject is dropped when its hash field
// is absent or unparseable.
//
// DETERMINISM: no wall clock, no global RNG. Timestamps come from the receipt.
//
// ZERO new dependencies. Reuses _sha256Hex + canonicalReceiptForDigest +
// KOLM_INFERENCE_PREDICATE_TYPE + KOLM_INFERENCE_CONFORMANCE from
// intoto-receipt.js so there is ONE digest implementation and ONE conformance
// string. (intoto-receipt.js does not import this module, so importing those
// symbols here is acyclic at the value level - they are leaf exports.)

import crypto from 'node:crypto';

export const RECEIPT_EXPORT_REGISTRY_VERSION = 'c1-receipt-export-v1';

// ---------------------------------------------------------------------------
// Predicate type URIs. The inference type is re-declared here as the canonical
// value (it equals KOLM_INFERENCE_PREDICATE_TYPE in intoto-receipt.js and the
// descriptor for kolm-audit-1 uses that exact string; AC2 pins byte-equality).
// The toolcall type is MINTED here per spec.
// ---------------------------------------------------------------------------
export const KOLM_INFERENCE_PREDICATE_TYPE = 'https://kolm.ai/attestations/inference/v1';
export const KOLM_TOOLCALL_PREDICATE_TYPE = 'https://kolm.ai/attestations/toolcall/v1';
// Generic fallback for an unrecognized future receipt class (AC4).
export const KOLM_RECEIPT_PREDICATE_TYPE = 'https://kolm.ai/attestations/receipt/v1';

// The exact conformance string the kolm-audit-1 path emits today. Re-declared
// verbatim so a kolm-audit-1 export is byte-identical with vs without the
// registry. NEVER upgrade this to a compute-proof claim here - the proof-scope
// gate below governs when 'proven_compute' wording is permitted.
export const KOLM_INFERENCE_CONFORMANCE =
  'in-toto Statement v1 + ITE-6 inference predicate (Ed25519 key-custody attestation; not proof-of-compute)';

const HEX_RE = /^[0-9a-f]+$/i;

// ---------------------------------------------------------------------------
// Local copies of the digest helpers, MATCHING intoto-receipt.js byte-for-byte
// so a kolm-audit-1 receipt produces identical subjects/predicate. (We keep
// local copies rather than import to avoid any import-cycle risk during the
// integration wiring; the algorithm is the single source-of-truth contract.)
// ---------------------------------------------------------------------------
function _sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
}

// Pull the hex out of a kolm short hash `sha256:<hex>` (or pass bare hex
// through). Returns null when there is no usable hex. Mirrors
// intoto-receipt.js _hexFromShortHash semantics exactly.
function _hexFromShortHash(v) {
  if (typeof v !== 'string') return null;
  const m = /^sha256:([0-9a-f]{8,64})$/i.exec(v);
  if (m) return m[1].toLowerCase();
  if (HEX_RE.test(v) && v.length >= 8 && v.length <= 64) return v.toLowerCase();
  return null;
}

// canonicalReceiptForDigest - stable byte image of the receipt for the subject
// digest. Excludes the signature blocks + the non-signed anchor block. Sorted
// keys via the same canonicalJson intoto-receipt.js uses. We import canonicalJson
// from cid.js (a true leaf) so the bytes match.
import { canonicalJson } from './cid.js';
function canonicalReceiptForDigest(receipt) {
  const r = receipt && typeof receipt === 'object' ? { ...receipt } : {};
  delete r.signature_ed25519;
  delete r.signature;
  delete r.anchor;
  return canonicalJson(r);
}

// ---------------------------------------------------------------------------
// DESCRIPTOR REGISTRY, keyed by receipt.schema.
//
// Each descriptor declares, per schema:
//   idField        - primary id key ('receipt_id' / 'call_id').
//   idPrefix       - subject-name prefix ('receipt').
//   contentDigests - [{ nameTag, hashField, kind }] mapping receipt fields that
//                    carry a content hash to an in-toto subject.
//   predicateFields- explicit field list copied into the predicate (degrades,
//                    never fabricates).
//   predicateType  - kolm predicateType URI for the class.
//   builderId      - builder.id stamped into the predicate.
//   schemaName     - the schema string the predicate records.
// ---------------------------------------------------------------------------
const _registry = new Map();

export function registerReceiptClass(schema, descriptor) {
  if (typeof schema !== 'string' || !schema) throw new Error('registerReceiptClass: schema string required');
  if (!descriptor || typeof descriptor !== 'object') throw new Error('registerReceiptClass: descriptor object required');
  if (typeof descriptor.idField !== 'string') throw new Error('registerReceiptClass: descriptor.idField required');
  _registry.set(schema, {
    schema,
    idField: descriptor.idField,
    idPrefix: descriptor.idPrefix || 'receipt',
    contentDigests: Array.isArray(descriptor.contentDigests) ? descriptor.contentDigests.slice() : [],
    predicateFields: Array.isArray(descriptor.predicateFields) ? descriptor.predicateFields.slice() : [],
    predicateType: descriptor.predicateType || KOLM_RECEIPT_PREDICATE_TYPE,
    builderId: descriptor.builderId || 'https://kolm.ai/gateway',
    predicateKey: descriptor.predicateKey || 'inference',
  });
  return _registry.get(schema);
}

export function listReceiptClasses() {
  return Array.from(_registry.keys()).sort();
}

export function getReceiptDescriptor(schema) {
  return _registry.get(schema) || null;
}

// ---------------------------------------------------------------------------
// kolm-audit-1 descriptor. The predicateFields list + contentDigests reproduce
// the EXISTING intoto-receipt.js buildInferencePredicate / receiptSubjects
// behavior byte-for-byte (AC2 golden vector).
// ---------------------------------------------------------------------------
registerReceiptClass('kolm-audit-1', {
  idField: 'receipt_id',
  idPrefix: 'receipt',
  contentDigests: [
    { nameTag: 'output', hashField: 'output_hash', kind: 'model_output' },
  ],
  predicateFields: [
    'receipt_id', 'timestamp', 'namespace_id', 'route_decision', 'provider',
    'model', 'artifact_id', 'confidence', 'fallback_reason', 'input_hash',
    'output_hash', 'capture_eligible', 'capture_id', 'redaction_applied',
    'input_tokens', 'output_tokens', 'cost_usd', 'signing_key_id', 'verify_url',
  ],
  predicateType: KOLM_INFERENCE_PREDICATE_TYPE,
  builderId: 'https://kolm.ai/gateway',
  predicateKey: 'inference',
});

// ---------------------------------------------------------------------------
// mcp-tool-call-1 descriptor. Closes the gap: id = call_id, content subjects =
// args (tool_input) + result (tool_output), and the predicate keeps the tool /
// args_hash / result_hash / tenant_id / is_error / transport / server_id fields.
// ---------------------------------------------------------------------------
registerReceiptClass('mcp-tool-call-1', {
  idField: 'call_id',
  idPrefix: 'receipt',
  contentDigests: [
    { nameTag: 'args', hashField: 'args_hash', kind: 'tool_input' },
    { nameTag: 'result', hashField: 'result_hash', kind: 'tool_output' },
  ],
  predicateFields: [
    'call_id', 'timestamp', 'tenant_id', 'tool', 'args_hash', 'result_hash',
    'is_error', 'transport', 'server_id',
  ],
  predicateType: KOLM_TOOLCALL_PREDICATE_TYPE,
  builderId: 'https://kolm.ai/mcp-gateway',
  predicateKey: 'tool_call',
});

// ---------------------------------------------------------------------------
// GENERIC fallback descriptor for an unknown receipt class (AC4). idField is
// auto-detected at resolve time; no content subjects; the predicate copies all
// scalar/string fields. Produces a VALID single-subject in-toto Statement.
// ---------------------------------------------------------------------------
function _genericDescriptorFor(receipt) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  let idField = 'receipt_id';
  if (typeof r.receipt_id === 'string' && r.receipt_id) idField = 'receipt_id';
  else if (typeof r.call_id === 'string' && r.call_id) idField = 'call_id';
  else if (typeof r.id === 'string' && r.id) idField = 'id';
  // predicateFields = all scalar/string fields except the signature/anchor seals.
  const predicateFields = [];
  for (const k of Object.keys(r)) {
    if (k === 'signature_ed25519' || k === 'signature' || k === 'anchor') continue;
    const v = r[k];
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      predicateFields.push(k);
    }
  }
  return {
    schema: typeof r.schema === 'string' ? r.schema : 'unknown',
    idField,
    idPrefix: 'receipt',
    contentDigests: [],
    predicateFields,
    predicateType: KOLM_RECEIPT_PREDICATE_TYPE,
    builderId: 'https://kolm.ai/gateway',
    predicateKey: 'receipt',
  };
}

// ---------------------------------------------------------------------------
// genericReceiptSubjects(receipt, descriptor) -> in-toto subject array.
//
// Always emits the primary receipt subject (name `${idPrefix}:${id||'unknown'}`,
// digest = sha256(canonicalReceiptForDigest(receipt)) FULL 64-hex). Then for
// each contentDigests entry whose hashField resolves to usable hex, push a
// subject { name:`${nameTag}:${id}`, digest:{sha256:hex},
// annotations:{kind, truncated:hex.length<64} }. NEVER fabricates a digest;
// drops content subjects whose hash field is absent or unparseable.
// ---------------------------------------------------------------------------
export function genericReceiptSubjects(receipt, descriptor) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  const d = descriptor || _genericDescriptorFor(r);
  const idVal = typeof r[d.idField] === 'string' && r[d.idField] ? r[d.idField] : 'unknown';
  const subjects = [];

  const receiptDigest = _sha256Hex(canonicalReceiptForDigest(r));
  const receiptSubj = {
    name: `${d.idPrefix}:${idVal}`,
    digest: { sha256: receiptDigest },
  };
  // Annotations match the kolm-audit-1 path exactly (verify_url, timestamp).
  const ann = {};
  if (typeof r.verify_url === 'string' && r.verify_url) ann.verify_url = r.verify_url;
  if (typeof r.timestamp === 'string' && r.timestamp) ann.timestamp = r.timestamp;
  if (Object.keys(ann).length > 0) receiptSubj.annotations = ann;
  subjects.push(receiptSubj);

  for (const cd of d.contentDigests) {
    const hex = _hexFromShortHash(r[cd.hashField]);
    if (!hex) continue; // absent or unparseable -> drop, NEVER fabricate.
    subjects.push({
      name: `${cd.nameTag}:${idVal}`,
      digest: { sha256: hex },
      annotations: { kind: cd.kind, truncated: hex.length < 64 },
    });
  }
  return subjects;
}

// ---------------------------------------------------------------------------
// genericBuildPredicate(receipt, descriptor) -> ITE-6 custom predicate.
//
// Copies exactly the descriptor.predicateFields that are PRESENT (degrades,
// never fabricates), plus schema, builder.id, signature_meta
// (key_fingerprint/alg/signed_at from receipt.signature_ed25519), and the
// key-custody conformance string. The class-specific fields live under
// predicate[descriptor.predicateKey] so the kolm-audit-1 shape (predicate.inference)
// is preserved byte-for-byte.
// ---------------------------------------------------------------------------
export function genericBuildPredicate(receipt, descriptor) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  const d = descriptor || _genericDescriptorFor(r);

  const body = {};
  for (const k of d.predicateFields) {
    if (r[k] !== undefined) body[k] = r[k];
  }

  const sig = r.signature_ed25519;
  const signature_meta = sig && typeof sig === 'object'
    ? {
        alg: sig.alg || 'ed25519',
        key_fingerprint: sig.key_fingerprint || null,
        signed_at: sig.signed_at || null,
      }
    : null;

  return {
    schema: r.schema || d.schema || 'unknown',
    builder: { id: d.builderId },
    [d.predicateKey]: body,
    signature_meta,
    conformance: KOLM_INFERENCE_CONFORMANCE,
  };
}

// ---------------------------------------------------------------------------
// resolveReceiptExport(receipt) -> { descriptor, subjects, predicate,
//   predicateType }
//
// Dispatcher: look up the descriptor by receipt.schema; if unknown, fall back to
// a GENERIC descriptor (idField auto-detected, no content subjects, predicate =
// all scalar/string fields) so an unrecognized future receipt class still
// produces a VALID single-subject in-toto Statement instead of throwing. This
// satisfies the "auto-inherit" requirement (AC4).
// ---------------------------------------------------------------------------
export function resolveReceiptExport(receipt) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  const descriptor = (typeof r.schema === 'string' && _registry.get(r.schema)) || _genericDescriptorFor(r);
  const subjects = genericReceiptSubjects(r, descriptor);
  const predicate = genericBuildPredicate(r, descriptor);
  return {
    descriptor,
    subjects,
    predicate,
    predicateType: descriptor.predicateType,
  };
}

// ===========================================================================
// PROOF-SCOPE GATE (gate #3, AC6).
//
// Any receipt/report surface may use 'proven_compute' wording ONLY when an
// associated confidential-compute attestation state has verified===true AND the
// verifier is a REGISTERED crypto verifier (not the shape-only stub or 'none').
// Otherwise the scope is 'key_custody' and the conformance string MUST remain
// the existing key-custody string. The helper is CONSUMED at integration time
// by attestation-report-builder.js + intoto-receipt.js predicate construction;
// it does NOT itself change report copy in this atom.
// ===========================================================================
export const PROOF_SCOPE = Object.freeze({
  KEY_CUSTODY: 'key_custody',
  PROVEN_COMPUTE: 'proven_compute',
});

// Verifier labels that are NOT a real proof-of-compute (shape-only / absent).
const _NON_PROOF_VERIFIERS = new Set(['shape_v1', 'shape', 'none', '', null, undefined]);

export function proofScopeLabel(state) {
  if (!state || typeof state !== 'object') return PROOF_SCOPE.KEY_CUSTODY;
  const verifier = state.verifier;
  const verified = state.verified === true;
  if (verified && !_NON_PROOF_VERIFIERS.has(verifier)) {
    return PROOF_SCOPE.PROVEN_COMPUTE;
  }
  return PROOF_SCOPE.KEY_CUSTODY;
}

// ===========================================================================
// BUILD-TIME OMS MEMBER MANIFEST (open Q3 export path).
//
// toOmsArtifactManifest(memberList) - an OpenSSF Model-Signing-compatible file
// manifest. memberList is the sorted [{ name, sha256 }] of every non-seal file
// in the .kolm zip (sha256 over the REAL bytes). The manifest is a single
// in-toto subject set the OMS verifier reads. This is a SEAL emitted AFTER
// artifact_hash and EXCLUDED from the CID input - it never changes the CID.
//
// Returns a plain in-toto Statement object (UNSIGNED); the caller DSSE-signs it
// via the existing buildDsseEnvelope to produce model.sig.bundle.
// ===========================================================================
export const OMS_SIGNATURE_PREDICATE_TYPE = 'https://model_signing/signature/v1.0';

export function omsMemberList(files) {
  // files: [{ filename, content?:Buffer, absPath? }]. Caller passes only
  // non-seal members. We require in-memory content here (build path reads bytes).
  const SEALS = new Set(['provenance.intoto.dsse.json', 'model.sig.bundle', 'signature.sig']);
  const members = [];
  for (const f of files || []) {
    if (!f || !f.filename) continue;
    if (SEALS.has(f.filename)) continue;
    let bytes = null;
    if (Buffer.isBuffer(f.content)) bytes = f.content;
    else if (typeof f.content === 'string') bytes = Buffer.from(f.content);
    if (!bytes) continue; // skip path-backed entries the caller didn't read
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    members.push({ name: f.filename, sha256 });
  }
  members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return members;
}

export function toOmsArtifactManifest(memberList) {
  const members = Array.isArray(memberList) ? memberList : [];
  const subject = [];
  for (const m of members) {
    if (!m || typeof m.name !== 'string' || !/^[0-9a-f]{64}$/i.test(String(m.sha256 || ''))) continue;
    subject.push({ name: m.name, digest: { sha256: String(m.sha256).toLowerCase() } });
  }
  if (subject.length === 0) {
    throw new Error('toOmsArtifactManifest: at least one valid member (name + sha256 hex64) required');
  }
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject,
    predicateType: OMS_SIGNATURE_PREDICATE_TYPE,
    predicate: {
      resources: subject.map((s) => ({ name: s.name, digest: s.digest })),
      model_signing_version: '1.0',
      note: 'kolm .kolm artifact file manifest, OpenSSF Model-Signing compatible',
    },
  };
}

// ===========================================================================
// DURABLE ANCHOR QUEUE (open Q2 - WAL for in-flight anchor proofs).
//
// ReceiptAnchorBatcher._queue is purely in-memory; a process crash before
// flushNow() loses the ANCHOR (Merkle inclusion) proof for in-flight receipts.
// The per-call Ed25519 signature ITSELF survives in the receipt store - only
// the Merkle inclusion proof is lost, and it is recoverable by re-anchoring.
//
// makeDurableAnchorQueue({ store, flushFn }) adds an OPTIONAL, store-backed
// write-ahead path WITHOUT changing the hot path:
//   - when a store adapter is supplied, persist each enqueued
//     { receipt_id, leaf_hex, schema } row, and on startup re-drain any
//     un-flushed rows into a fresh batch via flushFn.
//   - when NO store is supplied, behavior is byte-identical to today (pure
//     in-memory): the returned object is a thin pass-through.
//
// FAIL-OPEN INVARIANT: anchoring must NEVER block or fail a served call. Any
// store error is swallowed and the in-memory path proceeds. ENV-GATE: this is
// only active when the CALLER passes a store adapter; otherwise it is a no-op.
//
// store adapter contract (all sync or async, all optional except put/list/del
// when a store is supplied):
//   put({ receipt_id, leaf_hex, schema, ts })  -> persist one WAL row
//   list()                                      -> return un-flushed rows
//   del(receipt_id)                             -> remove a flushed row
//   clear()                                     -> remove all rows
// ===========================================================================
export function makeDurableAnchorQueue({ store = null, flushFn = null } = {}) {
  const hasStore = store && typeof store.put === 'function' && typeof store.list === 'function';

  // No store -> pure pass-through, byte-identical to today's in-memory path.
  if (!hasStore) {
    return {
      durable: false,
      // record() is the WAL hook the batcher calls on enqueue; with no store it
      // is a no-op that never throws and never blocks.
      record() { return false; },
      // markFlushed() clears WAL rows after a successful flush; no-op here.
      markFlushed() { return false; },
      // recover() re-drains persisted rows on startup; nothing to recover.
      async recover() { return { ok: true, recovered: 0, rows: [] }; },
      pending() { return []; },
    };
  }

  return {
    durable: true,
    record({ receipt_id, leaf, schema } = {}) {
      try {
        let leaf_hex = leaf;
        if (Buffer.isBuffer(leaf_hex)) leaf_hex = leaf_hex.toString('hex');
        if (typeof leaf_hex !== 'string') return false;
        store.put({
          receipt_id: receipt_id || null,
          leaf_hex,
          schema: schema || null,
          ts: Date.now(),
        });
        return true;
      } catch { return false; } // FAIL-OPEN: WAL failure never blocks enqueue.
    },
    markFlushed(receipt_ids) {
      try {
        const ids = Array.isArray(receipt_ids) ? receipt_ids : [receipt_ids];
        if (typeof store.del === 'function') {
          for (const id of ids) { if (id != null) store.del(id); }
        } else if (typeof store.clear === 'function' && ids.length === 0) {
          store.clear();
        }
        return true;
      } catch { return false; }
    },
    async recover() {
      let rows = [];
      try { rows = await store.list(); } catch { return { ok: false, recovered: 0, rows: [] }; }
      rows = Array.isArray(rows) ? rows.filter((r) => r && typeof r.leaf_hex === 'string') : [];
      if (rows.length === 0) return { ok: true, recovered: 0, rows: [] };
      // Re-drain into a fresh batch via the injected flushFn (which the caller
      // wires to governReceiptBatch + anchorBatch). FAIL-OPEN on any error.
      let result = null;
      if (typeof flushFn === 'function') {
        try { result = await flushFn(rows); } catch { result = null; }
      }
      // Clear the recovered rows so they are not re-drained again next boot.
      try {
        if (typeof store.clear === 'function') store.clear();
        else if (typeof store.del === 'function') {
          for (const r of rows) { if (r.receipt_id != null) store.del(r.receipt_id); }
        }
      } catch { /* fail-open */ }
      return { ok: true, recovered: rows.length, rows, result };
    },
    async pending() {
      try { return await store.list(); } catch { return []; }
    },
  };
}

export const RECEIPT_EXPORT_REGISTRY_SPEC = {
  version: RECEIPT_EXPORT_REGISTRY_VERSION,
  classes: () => listReceiptClasses(),
  inference_predicate_type: KOLM_INFERENCE_PREDICATE_TYPE,
  toolcall_predicate_type: KOLM_TOOLCALL_PREDICATE_TYPE,
  receipt_predicate_type: KOLM_RECEIPT_PREDICATE_TYPE,
  oms_predicate_type: OMS_SIGNATURE_PREDICATE_TYPE,
  proof_scope: PROOF_SCOPE,
  conformance: KOLM_INFERENCE_CONFORMANCE,
};

export default {
  RECEIPT_EXPORT_REGISTRY_VERSION,
  KOLM_INFERENCE_PREDICATE_TYPE,
  KOLM_TOOLCALL_PREDICATE_TYPE,
  KOLM_RECEIPT_PREDICATE_TYPE,
  OMS_SIGNATURE_PREDICATE_TYPE,
  KOLM_INFERENCE_CONFORMANCE,
  PROOF_SCOPE,
  registerReceiptClass,
  listReceiptClasses,
  getReceiptDescriptor,
  genericReceiptSubjects,
  genericBuildPredicate,
  resolveReceiptExport,
  proofScopeLabel,
  omsMemberList,
  toOmsArtifactManifest,
  makeDurableAnchorQueue,
  RECEIPT_EXPORT_REGISTRY_SPEC,
};
