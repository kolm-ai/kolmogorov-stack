// src/kolm-pack/oci-descriptor.js
//
// ATOM: Signed .kolm Artifact Packaging Format -- OCI image-spec alignment.
//
// This module makes a .kolm package describe itself the way an OCI artifact
// does, so an *unmodified* OCI registry / CDN (ghcr.io, ECR, Artifactory,
// Cloudflare R2 fronted by an OCI proxy, or any static range-serving HTTP
// store) can host and range-serve the slots of a .kolm without knowing
// anything about kolm. The wire shape is the OCI Image Manifest
// (application/vnd.oci.image.manifest.v1+json) with kolm-specific media types
// for each slot (config + layers).
//
// Why OCI: the OCI image-spec descriptor is the lingua franca of model
// distribution (ORAS, HuggingFace's OCI export, modelpack, Docker model
// runner). A descriptor is { mediaType, digest, size, annotations? }. Its
// digest is `sha256:<hex>` over the EXACT bytes of the referenced object, and
// `size` is the byte length -- which is precisely what an HTTP `Range:` header
// needs to fetch a single slot ("lazy/partial fetch of large slots") without
// downloading the whole package.
//
// Pure JS, no deps beyond node:crypto. ASCII only.

import crypto from 'node:crypto';

// OCI image-spec v1.1 media types we reuse verbatim so generic OCI tooling
// recognises the envelope.
export const OCI_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
export const OCI_EMPTY_MEDIA_TYPE = 'application/vnd.oci.empty.v1+json';
// The empty-config descriptor's well-known digest+content (OCI image-spec
// guidance for artifacts that have no runnable config): the two bytes `{}`.
export const OCI_EMPTY_CONFIG = {
  mediaType: OCI_EMPTY_MEDIA_TYPE,
  // sha256 of the bytes `{}`
  digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  size: 2,
  data: 'e30=', // base64 of `{}`
};

// kolm-specific artifact type + per-slot layer media types. These live under
// the vnd.kolm.* namespace so an OCI registry stores them opaquely (it does
// NOT need to understand them) while kolm tooling can route each layer to the
// right decoder. The `artifactType` on the manifest lets a registry filter
// for .kolm packages (OCI image-spec v1.1 `artifactType`).
export const KOLM_ARTIFACT_TYPE = 'application/vnd.kolm.package.v1+json';
export const KOLM_MEDIA_TYPES = Object.freeze({
  config: 'application/vnd.kolm.config.v1+json',           // the kolm manifest.json
  recipes: 'application/vnd.kolm.recipes.v1+json',
  evals: 'application/vnd.kolm.evals.v1+json',
  model_pointer: 'application/vnd.kolm.model.pointer.v1+json',
  weights_tensors: 'application/vnd.kolm.weights.tensors.v1+kolmtns', // quantized tensor blob
  retrieval_index: 'application/vnd.kolm.retrieval.index.v1+kolmvec', // pure-JS sqlite-vec-shaped index
  retrieval_index_sqlite: 'application/vnd.kolm.retrieval.index.v1+sqlite3', // optional real sqlite-vec db
  recipe_bundle: 'application/vnd.kolm.recipe-bundle.v1+javascript',
  receipt: 'application/vnd.kolm.receipt.v1+json',
  signature: 'application/vnd.kolm.signature.v1+json',
  extra: 'application/vnd.kolm.extra.v1+octet-stream',
});

// sha256 digest in OCI form: `sha256:<lowercase-hex>`.
export function ociDigest(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
}

// Strip the algorithm prefix; returns bare hex or null if malformed.
export function digestHex(ociDigestStr) {
  if (typeof ociDigestStr !== 'string') return null;
  const m = /^sha256:([0-9a-f]{64})$/.exec(ociDigestStr);
  return m ? m[1] : null;
}

export function isValidOciDigest(d) {
  return digestHex(d) !== null;
}

// Build a single OCI content descriptor over a buffer. `annotations` is an
// optional flat string->string map (OCI requires string values).
export function describe(buf, mediaType, annotations) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const desc = {
    mediaType,
    digest: ociDigest(b),
    size: b.length,
  };
  if (annotations && typeof annotations === 'object') {
    const ann = {};
    for (const k of Object.keys(annotations).sort()) {
      ann[k] = String(annotations[k]);
    }
    if (Object.keys(ann).length) desc.annotations = ann;
  }
  return desc;
}

// Validate a descriptor shape (defensive read path for old/foreign artifacts).
export function validateDescriptor(desc) {
  if (!desc || typeof desc !== 'object') return { ok: false, reason: 'descriptor not an object' };
  if (typeof desc.mediaType !== 'string' || !desc.mediaType) return { ok: false, reason: 'mediaType missing' };
  if (!isValidOciDigest(desc.digest)) return { ok: false, reason: 'digest not sha256:<64hex>' };
  if (!Number.isInteger(desc.size) || desc.size < 0) return { ok: false, reason: 'size not a non-negative integer' };
  if (desc.annotations != null) {
    if (typeof desc.annotations !== 'object' || Array.isArray(desc.annotations)) {
      return { ok: false, reason: 'annotations must be a flat object' };
    }
    for (const v of Object.values(desc.annotations)) {
      if (typeof v !== 'string') return { ok: false, reason: 'annotation values must be strings (OCI rule)' };
    }
  }
  return { ok: true };
}

// Confirm a descriptor's digest+size actually match the bytes. This is the
// content-addressing guarantee: a CDN/registry can serve a slot from anywhere,
// but the consumer re-checks the bytes against the descriptor before trusting.
export function verifyDescriptorBytes(desc, buf) {
  const v = validateDescriptor(desc);
  if (!v.ok) return { ok: false, reason: v.reason };
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length !== desc.size) return { ok: false, reason: `size mismatch: descriptor=${desc.size} bytes=${b.length}` };
  const got = ociDigest(b);
  // length-checked constant-time compare on the hex strings
  const a = Buffer.from(got);
  const e = Buffer.from(desc.digest);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) {
    return { ok: false, reason: `digest mismatch: descriptor=${desc.digest} bytes=${got}` };
  }
  return { ok: true };
}

// Build the OCI image manifest envelope from a config descriptor + ordered
// layer descriptors. `annotations` ride at manifest level (OCI standard keys
// like org.opencontainers.image.created are allowed alongside vnd.kolm.* keys).
export function buildOciManifest({ config, layers, annotations, subject }) {
  if (!config) throw new Error('buildOciManifest: config descriptor required');
  if (!Array.isArray(layers)) throw new Error('buildOciManifest: layers must be an array');
  const manifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST_MEDIA_TYPE,
    artifactType: KOLM_ARTIFACT_TYPE,
    config,
    layers: layers.slice(),
  };
  if (subject) manifest.subject = subject;
  if (annotations && typeof annotations === 'object') {
    const ann = {};
    for (const k of Object.keys(annotations).sort()) ann[k] = String(annotations[k]);
    if (Object.keys(ann).length) manifest.annotations = ann;
  }
  return manifest;
}
