// src/kolm-pack/package-format.js
//
// ATOM: Signed .kolm Artifact Packaging Format -- the streamable, content-
// addressed, OCI-aligned package container with deterministic reproducible
// builds, lazy/partial slot fetch, and signed manifests with backward-
// compatible verification of old schema versions.
//
// On-disk layout of a `.kolm` package (a single self-describing file that an
// OCI registry / static CDN can also serve as separate range-addressable
// blobs):
//
//   magic   "KOLMPKG\x02"            (8 bytes; distinguishes the new container
//                                      from the legacy zip-based .kolm)
//   u32     index_len L              (LE)
//   index   utf8 JSON package-index (see below), length L
//   blobs   concatenated blob bytes, each addressed by the index entry's
//           {offset,length}. Blobs are stored ONCE per unique digest (content-
//           addressed dedup), in ascending digest order for determinism.
//
// The package-index JSON is:
//   {
//     "spec": "kolm-pkg-1",
//     "format_version": "2.0",
//     "oci": <OCI image manifest>,          // config + layers descriptors
//     "blobs": { "<sha256:hex>": { "offset": <int>, "length": <int> } },
//     "signature_ed25519": {...} | null,    // signs the canonical index sans
//                                            // this field; verifiable offline
//     "legacy_artifact_hash": "<hex>" | null
//   }
//
// DETERMINISM: blobs are deduped by digest and laid out in ascending digest
// order; the index JSON is canonicalized (sorted keys); the OCI manifest layers
// keep declaration order but each descriptor is canonical. Given the same input
// slots, packPackage() returns byte-identical bytes -- a reproducible build.
// reproChecksum() lets a verifier rebuild from the manifest's descriptors and
// confirm a byte-exact match.
//
// BACKWARD COMPAT: readPackage() understands format_version 2.x. A
// SCHEMA_REGISTRY maps each known version to a validator so a 2.0 reader can
// verify a future 2.1 artifact's signature/digests without choking on
// additive fields, and refuses a major-version bump loudly.
//
// LAZY/PARTIAL FETCH: blobRange(index, digest) returns the {start,end} byte
// range of a blob inside the package file so a consumer can HTTP-Range-fetch a
// single slot (or, via weights-tensors.tensorByteRange, a single tensor inside
// the weights slot) without reading the whole package.
//
// Pure JS, node:crypto only. ASCII only.

import crypto from 'node:crypto';
import {
  describe, ociDigest, digestHex, verifyDescriptorBytes, buildOciManifest,
  KOLM_MEDIA_TYPES, KOLM_ARTIFACT_TYPE, OCI_EMPTY_CONFIG, validateDescriptor,
} from './oci-descriptor.js';
import {
  loadOrCreateDefaultSigner as loadEd25519DefaultSigner,
  buildSignatureBlock as buildEd25519Block,
  verifySignatureBlock as verifyEd25519Block,
} from '../ed25519.js';

export const PKG_SPEC = 'kolm-pkg-1';
export const PKG_FORMAT_VERSION = '2.0';
const PKG_MAGIC = 'KOLMPKG\x02';

// ---- formally-versioned, backward-compatible schema registry -------------
// Each entry validates the package-index for that schema line. A reader for
// major version 2 accepts any 2.x (additive minor bumps), and REFUSES a major
// bump it does not know (loud, never silent).
export const SCHEMA_REGISTRY = Object.freeze({
  '2.0': {
    major: 2,
    minor: 0,
    requiredIndexKeys: ['spec', 'format_version', 'oci', 'blobs'],
    validate(index) {
      const errs = [];
      if (index.spec !== PKG_SPEC) errs.push(`spec must be ${PKG_SPEC}`);
      if (!index.oci || index.oci.mediaType !== 'application/vnd.oci.image.manifest.v1+json') {
        errs.push('oci must be an OCI image manifest');
      }
      if (index.oci && index.oci.artifactType !== KOLM_ARTIFACT_TYPE) {
        errs.push(`oci.artifactType must be ${KOLM_ARTIFACT_TYPE}`);
      }
      if (!index.blobs || typeof index.blobs !== 'object') errs.push('blobs map missing');
      return { ok: errs.length === 0, errors: errs };
    },
  },
});

// Resolve the validator for a format_version. Accepts any minor within the
// reader's known major; throws loudly on an unknown major.
export function resolveSchema(formatVersion) {
  const exact = SCHEMA_REGISTRY[formatVersion];
  if (exact) return exact;
  const m = /^(\d+)\.(\d+)$/.exec(String(formatVersion || ''));
  if (!m) throw new Error(`unparseable format_version: ${JSON.stringify(formatVersion)}`);
  const major = Number(m[1]);
  // Find the highest known schema with the same major -> forward-compatible.
  let best = null;
  for (const v of Object.keys(SCHEMA_REGISTRY)) {
    const s = SCHEMA_REGISTRY[v];
    if (s.major === major) { if (!best || s.minor > best.minor) best = s; }
  }
  if (best) return best; // same major, newer minor: additive, verify with what we know
  throw new Error(
    `unsupported .kolm package major version ${major} (reader knows major 2). ` +
    'Upgrade the kolm tooling to read this artifact.',
  );
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map((x) => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

// The canonical signing payload for the package index: the index object MINUS
// the signature_ed25519 field, canonicalized. So a verifier recomputes this
// exactly without the signer's secret.
function signingPayload(index) {
  const copy = { ...index };
  delete copy.signature_ed25519;
  return canonicalJson(copy);
}

// ---- pack -----------------------------------------------------------------
// `slots` is an object mapping a slot kind -> { buf, mediaType?, annotations? }.
// The `config` slot (the kolm manifest.json bytes) is REQUIRED. Everything else
// is a layer. Returns { bytes, index, oci, descriptors }.
//
// signer: pass false to skip signing, or an explicit { privateKey, publicKey,
// key_fingerprint } object; default loads/creates the per-machine Ed25519 key
// (same path as the rest of the codebase, KOLM_ED25519_* env honoured).
export function packPackage({ config, layers = [], annotations = {}, signer, legacy_artifact_hash = null } = {}) {
  if (!config || !Buffer.isBuffer(config.buf)) {
    throw new Error('packPackage: config.buf (the kolm manifest bytes) is required');
  }
  // Build descriptors. Config first, then layers in declaration order.
  const configDesc = describe(config.buf, config.mediaType || KOLM_MEDIA_TYPES.config, config.annotations);
  const layerDescs = layers.map((l) => {
    if (!Buffer.isBuffer(l.buf)) throw new Error(`layer ${l.mediaType || '?'} missing buf`);
    return describe(l.buf, l.mediaType || KOLM_MEDIA_TYPES.extra, l.annotations);
  });

  // Content-addressed blob store: dedup by digest, deterministic ascending order.
  const byDigest = new Map();
  function addBlob(buf, desc) {
    if (!byDigest.has(desc.digest)) byDigest.set(desc.digest, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }
  addBlob(config.buf, configDesc);
  layers.forEach((l, i) => addBlob(l.buf, layerDescs[i]));

  const orderedDigests = Array.from(byDigest.keys()).sort();
  const blobs = {};
  const chunks = [];
  let offset = 0;
  for (const d of orderedDigests) {
    const b = byDigest.get(d);
    blobs[d] = { offset, length: b.length };
    chunks.push(b);
    offset += b.length;
  }

  const oci = buildOciManifest({
    config: configDesc,
    layers: layerDescs,
    annotations: {
      'org.opencontainers.image.created': '1970-01-01T00:00:00Z', // fixed -> reproducible
      ...annotations,
    },
  });

  let index = {
    spec: PKG_SPEC,
    format_version: PKG_FORMAT_VERSION,
    oci,
    blobs,
    legacy_artifact_hash: legacy_artifact_hash || null,
    signature_ed25519: null,
  };

  // Sign the canonical index (minus the signature field). Default signer loads
  // the per-machine key so every package is signed; pass signer:false to skip.
  let usedSigner = null;
  if (signer !== false) {
    usedSigner = signer || loadEd25519DefaultSigner();
    if (usedSigner) {
      index.signature_ed25519 = buildEd25519Block({
        privateKey: usedSigner.privateKey,
        publicKey: usedSigner.publicKey,
        key_fingerprint: usedSigner.key_fingerprint,
        payloadCanonical: signingPayload(index),
        signed_at: '1970-01-01T00:00:00Z', // fixed -> reproducible bytes
      });
    }
  }

  const indexJson = Buffer.from(canonicalJson(index), 'utf8');
  const magic = Buffer.from(PKG_MAGIC, 'binary');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(indexJson.length, 0);
  const bytes = Buffer.concat([magic, lenBuf, indexJson, ...chunks]);

  return { bytes, index, oci, descriptors: { config: configDesc, layers: layerDescs }, signer: usedSigner };
}

// ---- read -----------------------------------------------------------------
// Parses the container, validates against the resolved schema, and returns an
// accessor. Does NOT verify the signature/digests by default (cheap parse);
// call verifyPackage() for the full check.
export function readPackage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) throw new Error('package too short');
  if (bytes.slice(0, 8).toString('binary') !== PKG_MAGIC) {
    throw new Error('not a kolm-pkg-2 package (magic mismatch). Legacy zip .kolm files use the artifact.js reader.');
  }
  const indexLen = bytes.readUInt32LE(8);
  const indexStart = 12;
  if (indexStart + indexLen > bytes.length) throw new Error('package index length exceeds file');
  const index = JSON.parse(bytes.slice(indexStart, indexStart + indexLen).toString('utf8'));
  const schema = resolveSchema(index.format_version);
  const v = schema.validate(index);
  if (!v.ok) throw new Error(`package index invalid for schema ${schema.major}.${schema.minor}: ${v.errors.join('; ')}`);

  const blobBase = indexStart + indexLen;

  function blobBytes(digest) {
    const loc = index.blobs[digest];
    if (!loc) throw new Error(`blob ${digest} not in package`);
    return bytes.slice(blobBase + loc.offset, blobBase + loc.offset + loc.length);
  }
  // Absolute byte range of a blob inside the package file -> HTTP Range input.
  function blobRange(digest) {
    const loc = index.blobs[digest];
    if (!loc) throw new Error(`blob ${digest} not in package`);
    return { start: blobBase + loc.offset, end: blobBase + loc.offset + loc.length, length: loc.length };
  }
  // Resolve a layer by media type (first match) -> its bytes.
  function layerBytesByMediaType(mediaType) {
    const desc = index.oci.layers.find((l) => l.mediaType === mediaType);
    if (!desc) return null;
    return blobBytes(desc.digest);
  }
  function configBytes() {
    return blobBytes(index.oci.config.digest);
  }
  function descriptors() {
    return [index.oci.config, ...index.oci.layers];
  }

  return {
    index, schema, blobBase,
    blobBytes, blobRange, layerBytesByMediaType, configBytes, descriptors,
  };
}

// ---- verify ---------------------------------------------------------------
// Full integrity check, no secret required:
//   1. every descriptor's digest+size match the stored blob bytes
//      (content-addressing -- detects tamper/corruption from any CDN)
//   2. the Ed25519 signature (when present) verifies against the canonical
//      index, so the package's identity + slot digests are provably authored
//      by the holder of the signing key.
//
// Returns { ok, signed, key_fingerprint?, reasons[] }.
export function verifyPackage(bytes, { requireSignature = false } = {}) {
  const reasons = [];
  let pkg;
  try { pkg = readPackage(bytes); }
  catch (e) { return { ok: false, signed: false, reasons: [String(e.message)] }; }

  // Content-addressing: re-hash every blob against its descriptor.
  for (const desc of pkg.descriptors()) {
    const dv = validateDescriptor(desc);
    if (!dv.ok) { reasons.push(`bad descriptor: ${dv.reason}`); continue; }
    let blob;
    try { blob = pkg.blobBytes(desc.digest); }
    catch (e) { reasons.push(String(e.message)); continue; }
    const r = verifyDescriptorBytes(desc, blob);
    if (!r.ok) reasons.push(`slot ${desc.mediaType}: ${r.reason}`);
  }

  // Signature.
  const sigBlock = pkg.index.signature_ed25519;
  let signed = false;
  let key_fingerprint;
  if (sigBlock) {
    const payload = signingPayload(pkg.index);
    const sv = verifyEd25519Block(sigBlock, payload);
    if (sv.ok) { signed = true; key_fingerprint = sv.key_fingerprint; }
    else reasons.push(`signature: ${sv.reason}`);
  } else if (requireSignature) {
    reasons.push('signature required but package is unsigned');
  }

  return { ok: reasons.length === 0, signed, key_fingerprint, reasons };
}

// ---- reproducibility ------------------------------------------------------
// A reproducible-build proof: the deterministic checksum of a package is fully
// determined by (a) the ordered set of slot bytes and (b) the signer key. Two
// builders with the same inputs + same key produce byte-identical packages, so
// reproChecksum(bytesA) === reproChecksum(bytesB). Independent of when/where it
// was built (created/signed_at are pinned to epoch).
export function reproChecksum(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Rebuild a package from a read accessor's slots + a signer and confirm it is
// byte-identical -- the strongest reproducible-build assertion. Returns
// { ok, expected, rebuilt }.
export function verifyReproducible(bytes, signer) {
  const pkg = readPackage(bytes);
  const configDesc = pkg.index.oci.config;
  const config = { buf: pkg.blobBytes(configDesc.digest), mediaType: configDesc.mediaType };
  const layers = pkg.index.oci.layers.map((l) => ({
    buf: pkg.blobBytes(l.digest),
    mediaType: l.mediaType,
    annotations: l.annotations,
  }));
  // Preserve any non-standard annotations the original package carried.
  const ann = { ...(pkg.index.oci.annotations || {}) };
  delete ann['org.opencontainers.image.created']; // re-stamped to epoch by packPackage
  const rebuilt = packPackage({
    config, layers, annotations: ann, signer, legacy_artifact_hash: pkg.index.legacy_artifact_hash,
  });
  const expected = reproChecksum(bytes);
  const got = reproChecksum(rebuilt.bytes);
  return { ok: expected === got, expected, rebuilt: got };
}

export const __internals = { canonicalJson, signingPayload };
