// src/kolm-pack/index.js
//
// ATOM: Signed .kolm Artifact Packaging Format -- public surface.
//
// A standardized, content-addressed, streamable model-package format on par
// with OCI artifacts / HF safetensors+model-card. This index wires the slot
// codecs (weights-tensors, retrieval-index) to the OCI-aligned, signed,
// reproducible package container (package-format) and exposes a single
// buildKolmPackage()/openKolmPackage() pair plus a CDN range-fetch helper.
//
// Privacy boundary (load-bearing for kolm): the package builder takes ONLY the
// bytes the caller hands it. It performs NO network calls and NO external
// model inference; sensitive vectors/weights stay local. The optional real
// sqlite-vec emit is env-gated (KOLM_SQLITE_VEC=1) and still runs entirely
// in-process against a temp file -- nothing is shipped to a hyperscaler.
//
// Pure JS, node:crypto only (plus optional env-gated sqlite path). ASCII only.

import {
  describe, ociDigest, digestHex, verifyDescriptorBytes, validateDescriptor,
  buildOciManifest, KOLM_MEDIA_TYPES, KOLM_ARTIFACT_TYPE,
  OCI_MANIFEST_MEDIA_TYPE, isValidOciDigest,
} from './oci-descriptor.js';
import {
  buildTensorBlob, parseTensorHeader, readTensor, tensorByteRange, tensorNames,
  quantizeAffine, dequantizeAffine, TENSORS_FORMAT,
} from './weights-tensors.js';
import {
  buildVectorIndex, openVectorIndex, indexInfo, buildSqliteVecIndex, VEC_FORMAT,
} from './retrieval-index.js';
import {
  packPackage, readPackage, verifyPackage, reproChecksum, verifyReproducible,
  resolveSchema, SCHEMA_REGISTRY, PKG_SPEC, PKG_FORMAT_VERSION,
} from './package-format.js';

// Build a complete signed .kolm package from high-level inputs.
//
//   manifest    : object (the kolm manifest.json) -- required
//   recipes     : object | null  (recipes.json)
//   evals       : object | null  (evals.json)
//   weights     : { tensors:[{name,data,shape}], quant } | null
//   retrieval   : { rows:[{id,vector,meta}], metric, sqlite? } | null
//   recipeBundle: string | null  (recipe.bundle.mjs source)
//   extras      : [{ name, buf, mediaType? }]  arbitrary additional slots
//   signer      : ed25519 signer | false | undefined (default: per-machine key)
//
// Returns { bytes, index, oci, cid, descriptors }.
export function buildKolmPackage(opts = {}) {
  const {
    manifest, recipes = null, evals = null, weights = null, retrieval = null,
    recipeBundle = null, extras = [], signer, annotations = {}, legacy_artifact_hash = null,
  } = opts;
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('buildKolmPackage: manifest object required');
  }
  const enc = (o) => Buffer.from(JSON.stringify(o), 'utf8');
  const config = { buf: enc(manifest), mediaType: KOLM_MEDIA_TYPES.config };
  const layers = [];

  if (recipes) layers.push({ buf: enc(recipes), mediaType: KOLM_MEDIA_TYPES.recipes });
  if (evals) layers.push({ buf: enc(evals), mediaType: KOLM_MEDIA_TYPES.evals });

  if (weights) {
    const buf = buildTensorBlob(weights.tensors, weights.quant || 'int8');
    layers.push({
      buf,
      mediaType: KOLM_MEDIA_TYPES.weights_tensors,
      annotations: { 'vnd.kolm.quant': weights.quant || 'int8', 'vnd.kolm.tensors.format': TENSORS_FORMAT },
    });
  }

  if (retrieval) {
    if (retrieval.sqlite) {
      // env-gated real sqlite-vec path (fails loud if disabled / deps missing)
      const buf = buildSqliteVecIndex(retrieval.rows, { metric: retrieval.metric || 'cosine' });
      layers.push({ buf, mediaType: KOLM_MEDIA_TYPES.retrieval_index_sqlite });
    } else {
      const buf = buildVectorIndex(retrieval.rows, { metric: retrieval.metric || 'cosine' });
      layers.push({
        buf,
        mediaType: KOLM_MEDIA_TYPES.retrieval_index,
        annotations: { 'vnd.kolm.vec.format': VEC_FORMAT },
      });
    }
  }

  if (recipeBundle) {
    layers.push({ buf: Buffer.from(recipeBundle, 'utf8'), mediaType: KOLM_MEDIA_TYPES.recipe_bundle });
  }

  for (const x of extras) {
    if (!x || !Buffer.isBuffer(x.buf)) throw new Error('extras entries need { name, buf:Buffer }');
    layers.push({
      buf: x.buf,
      mediaType: x.mediaType || KOLM_MEDIA_TYPES.extra,
      annotations: x.name ? { 'org.opencontainers.image.title': String(x.name) } : undefined,
    });
  }

  const packed = packPackage({ config, layers, annotations, signer, legacy_artifact_hash });
  // The package CID is the digest of the OCI config descriptor -- the manifest
  // bytes are the package identity (OCI registries key on the config digest).
  const cid = `cidv1:sha256:${digestHex(packed.oci.config.digest)}`;
  return { bytes: packed.bytes, index: packed.index, oci: packed.oci, cid, descriptors: packed.descriptors, signer: packed.signer };
}

// Open a package for reading + typed slot accessors.
export function openKolmPackage(bytes) {
  const pkg = readPackage(bytes);
  return {
    ...pkg,
    manifest() { return JSON.parse(pkg.configBytes().toString('utf8')); },
    recipes() {
      const b = pkg.layerBytesByMediaType(KOLM_MEDIA_TYPES.recipes);
      return b ? JSON.parse(b.toString('utf8')) : null;
    },
    evals() {
      const b = pkg.layerBytesByMediaType(KOLM_MEDIA_TYPES.evals);
      return b ? JSON.parse(b.toString('utf8')) : null;
    },
    weightsBuf() { return pkg.layerBytesByMediaType(KOLM_MEDIA_TYPES.weights_tensors); },
    readWeight(name) {
      const b = pkg.layerBytesByMediaType(KOLM_MEDIA_TYPES.weights_tensors);
      if (!b) return null;
      return readTensor(b, name);
    },
    retrieval() {
      const b = pkg.layerBytesByMediaType(KOLM_MEDIA_TYPES.retrieval_index);
      return b ? openVectorIndex(b) : null;
    },
  };
}

// Lazy/partial fetch: compute the byte range of a single slot (by media type)
// inside the package, so a consumer can issue ONE HTTP Range request against a
// static CDN that hosts the .kolm file unmodified. For the weights slot, you
// can drill further with tensorByteRange() into a single tensor.
export function slotByteRange(bytes, mediaType) {
  const pkg = readPackage(bytes);
  const desc = mediaType === pkg.index.oci.config.mediaType
    ? pkg.index.oci.config
    : pkg.index.oci.layers.find((l) => l.mediaType === mediaType);
  if (!desc) throw new Error(`no slot with mediaType ${mediaType}`);
  return { ...pkg.blobRange(desc.digest), digest: desc.digest, mediaType };
}

export {
  // OCI descriptor layer
  describe, ociDigest, digestHex, verifyDescriptorBytes, validateDescriptor,
  buildOciManifest, KOLM_MEDIA_TYPES, KOLM_ARTIFACT_TYPE, OCI_MANIFEST_MEDIA_TYPE, isValidOciDigest,
  // weights
  buildTensorBlob, parseTensorHeader, readTensor, tensorByteRange, tensorNames,
  quantizeAffine, dequantizeAffine, TENSORS_FORMAT,
  // retrieval
  buildVectorIndex, openVectorIndex, indexInfo, buildSqliteVecIndex, VEC_FORMAT,
  // container
  packPackage, readPackage, verifyPackage, reproChecksum, verifyReproducible,
  resolveSchema, SCHEMA_REGISTRY, PKG_SPEC, PKG_FORMAT_VERSION,
};
