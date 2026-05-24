// W831-3 — Sneakernet bundle with Ed25519 signatures.
//
// Purpose
// -------
// W779's src/sneakernet.js packs a .kolm into a tarball signed with HMAC-SHA256
// (shared-secret). W831-3 is the higher-trust variant: same tar layout, but
// the signature is Ed25519 over a detached payload + a kolm-airgap-receipt.json
// surfaces both the signature status and the recipient-pubkey match.
//
// The Ed25519 path is the one classified-deployment operators use because:
//
//   - Public-key crypto: the sender does NOT need to share a secret with the
//     receiver. A compromise of the signing key on the sender does not
//     compromise the receiver's verification ability (the public key is
//     non-secret).
//   - Detached signatures: signature.bin is computed over (artifact_bytes ||
//     '\0' || canonical(manifest)) and stored in its own file. Tampering with
//     either side breaks verification.
//   - kolm-airgap-receipt.json records signer pubkey fingerprint + recipient
//     pubkey fingerprint + timestamp so an audit log can reconstruct the
//     transfer chain weeks later.
//
// Wire format (USTAR tar archive, deterministic file order):
//   artifact.kolm           — the .kolm payload, byte-identical to source
//   manifest.json           — {artifact_id, sha256_artifact, created_at,
//                              signer_pubkey_b64, recipient_pubkey_b64,
//                              version, transport, tenant}
//   signature.bin           — raw 64-byte Ed25519 signature
//   kolm-airgap-receipt.json — {signature_ok, recipient_ok, signer_fpr,
//                               recipient_fpr, verified_at, version}
//
// We deliberately produce a binary signature.bin (NOT base64) because:
//   (a) it round-trips through tar without encoding ambiguity
//   (b) crypto.verify accepts Buffer directly — no decode step
//   (c) the spec line in W831-3 says "signature.bin"
//
// W411 tenant fence: opts.tenant is recorded in the manifest; verify does NOT
// enforce tenant — the route layer compares manifest.tenant to req.tenant_record.id
// before treating the bundle as belonging to the calling tenant.
//
// W604 version stamp: AIRGAP_SNEAKERNET_VERSION = 'w831-v1'. Consumers MUST
// match /^w831-/.
//
// Honesty invariants:
//   - createSneakernetBundle returns ok:false when artifact OR signing key
//     is missing — never silent passthrough.
//   - verifySneakernetBundle returns BOTH signature_ok AND recipient_ok as
//     booleans. A tampered bundle yields signature_ok:false; a bundle signed
//     by the wrong recipient (or missing recipient) yields recipient_ok:false.
//   - Signature verification uses crypto.verify('ed25519', ...) which is the
//     node:crypto built-in — no third-party deps.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AIRGAP_SNEAKERNET_VERSION = 'w831-v1';

// =============================================================================
// Minimal USTAR-compatible tar writer / reader. Same shape as src/sneakernet.js
// (W779) — we don't share code on purpose, because that module's signature
// path is HMAC-SHA256 and we want the Ed25519 path to evolve independently
// without risk of cross-coupling.
// =============================================================================

const TAR_BLOCK = 512;

function writeOctal(buf, offset, len, value) {
  const oct = value.toString(8);
  const padded = oct.padStart(len - 1, '0') + '\x00';
  buf.write(padded, offset, len, 'binary');
}

function writeTarHeader(name, size, mtime) {
  if (Buffer.byteLength(name, 'utf8') > 100) {
    throw new Error('tar: filename too long for USTAR header: ' + name);
  }
  const header = Buffer.alloc(TAR_BLOCK, 0);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  header.write('        ', 148, 8, 'binary'); // checksum slot (ASCII spaces)
  header.write('0', 156, 1, 'binary');        // typeflag = 0 (regular file)
  header.write('ustar\x0000', 257, 8, 'binary');
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += header[i];
  const csOct = sum.toString(8).padStart(6, '0') + '\x00 ';
  header.write(csOct, 148, 8, 'binary');
  return header;
}

function padToBlock(body) {
  const remainder = body.length % TAR_BLOCK;
  if (remainder === 0) return Buffer.alloc(0);
  return Buffer.alloc(TAR_BLOCK - remainder, 0);
}

function buildTarArchive(entries) {
  const chunks = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const ent of entries) {
    chunks.push(writeTarHeader(ent.name, ent.body.length, mtime));
    chunks.push(ent.body);
    const pad = padToBlock(ent.body);
    if (pad.length) chunks.push(pad);
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

function parseTarArchive(buf) {
  const entries = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= buf.length) {
    const header = buf.slice(offset, offset + TAR_BLOCK);
    if (header.every((b) => b === 0)) break;
    const nameRaw = header.slice(0, 100);
    const nulIdx = nameRaw.indexOf(0);
    const name = (nulIdx === -1 ? nameRaw : nameRaw.slice(0, nulIdx)).toString('utf8');
    if (!name) throw new Error('tar: empty filename at offset ' + offset);
    const sizeRaw = header.slice(124, 136);
    const sizeNul = sizeRaw.indexOf(0);
    const sizeOct = (sizeNul === -1 ? sizeRaw : sizeRaw.slice(0, sizeNul))
      .toString('ascii').trim();
    const size = sizeOct ? parseInt(sizeOct, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('tar: bad size header for ' + name);
    }
    const bodyStart = offset + TAR_BLOCK;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > buf.length) {
      throw new Error('tar: body for ' + name + ' extends past archive end');
    }
    const body = buf.slice(bodyStart, bodyEnd);
    entries.push({ name, body });
    const padded = size + (size % TAR_BLOCK === 0 ? 0 : TAR_BLOCK - (size % TAR_BLOCK));
    offset = bodyStart + padded;
  }
  return entries;
}

// =============================================================================
// Helpers: load PEM / raw signing key, canonical-form manifest, fingerprint.
// =============================================================================

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Canonical JSON: sorted keys so the same manifest object always hashes the
// same way. The Ed25519 signature is over canonical(manifest), not the
// pretty-printed manifest.json that ships in the tarball — that distinction
// is what lets us pretty-print manifest.json without breaking verify.
function canonicalManifestJson(manifest) {
  const keys = Object.keys(manifest).sort();
  const ordered = {};
  for (const k of keys) ordered[k] = manifest[k];
  return JSON.stringify(ordered);
}

// Load an Ed25519 private key from PEM (preferred) or raw 32-byte seed.
// Returns a KeyObject suitable for crypto.sign.
function loadSigningKey(signing_key_path) {
  const bytes = fs.readFileSync(signing_key_path);
  // PEM detection: starts with "-----BEGIN".
  const head = bytes.slice(0, 16).toString('utf8');
  if (head.startsWith('-----BEGIN')) {
    return crypto.createPrivateKey({ key: bytes, format: 'pem' });
  }
  // Raw seed (32 bytes) — wrap in PKCS#8 DER for createPrivateKey.
  if (bytes.length === 32) {
    // RFC 8410 PKCS#8 prefix for Ed25519: 0x302e020100300506032b657004220420
    const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
    const pkcs8 = Buffer.concat([prefix, bytes]);
    return crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  }
  throw new Error('signing key must be PEM-encoded or a raw 32-byte Ed25519 seed (got ' + bytes.length + ' bytes)');
}

// Load an Ed25519 public key from PEM or raw 32-byte form. Same trick as
// loadSigningKey but with the SubjectPublicKeyInfo wrapper.
function loadPublicKey(trusted_pubkey_path) {
  const bytes = fs.readFileSync(trusted_pubkey_path);
  const head = bytes.slice(0, 16).toString('utf8');
  if (head.startsWith('-----BEGIN')) {
    return crypto.createPublicKey({ key: bytes, format: 'pem' });
  }
  if (bytes.length === 32) {
    // RFC 8410 SubjectPublicKeyInfo prefix for Ed25519.
    const prefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spki = Buffer.concat([prefix, bytes]);
    return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  }
  throw new Error('public key must be PEM-encoded or a raw 32-byte Ed25519 key (got ' + bytes.length + ' bytes)');
}

// Derive a public key from a private key (KeyObject -> KeyObject). Used so
// the manifest can record signer_pubkey_b64 without the caller having to
// supply it explicitly.
function publicFromPrivate(privateKey) {
  return crypto.createPublicKey(privateKey);
}

// Render a public key to base64 of its raw 32-byte form. We export the SPKI
// DER and slice off the prefix — Node's exportKey({format:'jwk'}) gives the
// raw key as 'x' but that's also base64url so let's keep one consistent path.
function publicKeyToRawB64(pubKey) {
  const der = pubKey.export({ format: 'der', type: 'spki' });
  // The last 32 bytes of an Ed25519 SPKI are the raw key.
  if (der.length < 32) throw new Error('SPKI shorter than 32 bytes');
  return der.slice(der.length - 32).toString('base64');
}

// Fingerprint = sha256 of raw 32-byte public key, first 16 hex chars. Short
// but unique enough for an operator to recognize at a glance.
function pubKeyFingerprint(pubKey) {
  const der = pubKey.export({ format: 'der', type: 'spki' });
  return sha256Hex(der.slice(der.length - 32)).slice(0, 32);
}

// =============================================================================
// Public API.
// =============================================================================

// Build the canonical signing payload. Both pack + verify MUST agree on this
// exact byte layout; the leading 0x00 separator prevents a length-extension
// confusion attack between artifact bytes and the manifest JSON.
function signingPayload(artifactBytes, manifestCanonical) {
  return Buffer.concat([
    artifactBytes,
    Buffer.from([0x00]),
    Buffer.from(manifestCanonical, 'utf8'),
  ]);
}

// createSneakernetBundle({...}) — pack a .kolm into a tarball with Ed25519
// signature + receipt.
//
// Returns:
//   {ok:true, output_usb_path, sha256_archive, sha256_artifact, signer_fpr,
//    recipient_fpr, version}
//   {ok:false, error, detail, version}
//
// Args:
//   artifact_path       local .kolm to pack
//   signing_key_path    local Ed25519 private key (PEM or raw 32-byte seed)
//   output_usb_path     target tarball path (parent dir will be created)
//   recipient_pubkey_path  optional path to the recipient's public key — if
//                          supplied, embedded into manifest so the receiver
//                          can confirm the bundle was intended for them.
//                          If omitted, recipient_pubkey_b64 is null and
//                          verify's recipient_ok is true iff the trusted
//                          pubkey matches the signer (single-key flow).
//   artifact_id         optional id for the manifest (defaults to filename)
//   tenant              optional tenant_id (W411 surface attribution)
export function createSneakernetBundle(opts = {}) {
  const {
    artifact_path,
    signing_key_path,
    output_usb_path,
    recipient_pubkey_path = null,
    artifact_id,
    tenant = null,
  } = opts || {};
  if (!artifact_path) {
    return { ok: false, error: 'artifact_path_required', version: AIRGAP_SNEAKERNET_VERSION };
  }
  if (!signing_key_path) {
    return { ok: false, error: 'signing_key_path_required', version: AIRGAP_SNEAKERNET_VERSION };
  }
  if (!output_usb_path) {
    return { ok: false, error: 'output_usb_path_required', version: AIRGAP_SNEAKERNET_VERSION };
  }
  if (!fs.existsSync(artifact_path)) {
    return {
      ok: false,
      error: 'artifact_not_found',
      artifact_path,
      version: AIRGAP_SNEAKERNET_VERSION,
    };
  }
  if (!fs.existsSync(signing_key_path)) {
    return {
      ok: false,
      error: 'signing_key_not_found',
      signing_key_path,
      version: AIRGAP_SNEAKERNET_VERSION,
    };
  }

  let artifactBytes;
  try {
    artifactBytes = fs.readFileSync(artifact_path);
  } catch (e) {
    return {
      ok: false,
      error: 'artifact_read_error',
      detail: String((e && e.message) || e),
      version: AIRGAP_SNEAKERNET_VERSION,
    };
  }

  let signingKey;
  try {
    signingKey = loadSigningKey(signing_key_path);
  } catch (e) {
    return {
      ok: false,
      error: 'signing_key_load_error',
      detail: String((e && e.message) || e),
      version: AIRGAP_SNEAKERNET_VERSION,
    };
  }
  const signerPub = publicFromPrivate(signingKey);
  const signerPubB64 = publicKeyToRawB64(signerPub);
  const signerFpr = pubKeyFingerprint(signerPub);

  let recipientPub = null;
  let recipientPubB64 = null;
  let recipientFpr = null;
  if (recipient_pubkey_path) {
    if (!fs.existsSync(recipient_pubkey_path)) {
      return {
        ok: false,
        error: 'recipient_pubkey_not_found',
        recipient_pubkey_path,
        version: AIRGAP_SNEAKERNET_VERSION,
      };
    }
    try {
      recipientPub = loadPublicKey(recipient_pubkey_path);
      recipientPubB64 = publicKeyToRawB64(recipientPub);
      recipientFpr = pubKeyFingerprint(recipientPub);
    } catch (e) {
      return {
        ok: false,
        error: 'recipient_pubkey_load_error',
        detail: String((e && e.message) || e),
        version: AIRGAP_SNEAKERNET_VERSION,
      };
    }
  }

  const id = artifact_id || path.basename(artifact_path);
  const manifest = {
    artifact_id: id,
    sha256_artifact: sha256Hex(artifactBytes),
    created_at: new Date().toISOString(),
    signer_pubkey_b64: signerPubB64,
    recipient_pubkey_b64: recipientPubB64,
    version: AIRGAP_SNEAKERNET_VERSION,
    transport: 'sneakernet-ed25519',
    tenant,
  };
  const manifestCanonical = canonicalManifestJson(manifest);

  // crypto.sign('ed25519', data, key) -> 64-byte signature Buffer.
  // Pass `null` for the algorithm because Ed25519 doesn't take a hash arg.
  const signature = crypto.sign(null, signingPayload(artifactBytes, manifestCanonical), signingKey);

  // Pre-compute a receipt the receiver may use as a starting record. The
  // signature_ok / recipient_ok are populated on verify, not pack — the
  // receipt here is a SKELETON the receiver fills in.
  const receipt = {
    signer_fpr: signerFpr,
    recipient_fpr: recipientFpr,
    created_at: manifest.created_at,
    transport: manifest.transport,
    version: AIRGAP_SNEAKERNET_VERSION,
  };

  const tarBuf = buildTarArchive([
    { name: 'artifact.kolm', body: artifactBytes },
    { name: 'manifest.json', body: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
    { name: 'signature.bin', body: signature },
    {
      name: 'kolm-airgap-receipt.json',
      body: Buffer.from(JSON.stringify(receipt, null, 2) + '\n', 'utf8'),
    },
  ]);

  try {
    fs.mkdirSync(path.dirname(output_usb_path), { recursive: true });
    fs.writeFileSync(output_usb_path, tarBuf);
  } catch (e) {
    return {
      ok: false,
      error: 'bundle_write_error',
      detail: String((e && e.message) || e),
      version: AIRGAP_SNEAKERNET_VERSION,
    };
  }

  return {
    ok: true,
    output_usb_path,
    sha256_archive: sha256Hex(tarBuf),
    sha256_artifact: manifest.sha256_artifact,
    signer_fpr: signerFpr,
    recipient_fpr: recipientFpr,
    manifest,
    version: AIRGAP_SNEAKERNET_VERSION,
  };
}

// verifySneakernetBundle({...}) — open a tarball, recompute the canonical
// signing payload, run crypto.verify('ed25519', ...) against the trusted
// pubkey, AND compare the manifest's recipient slot to the trusted pubkey
// to confirm we are the intended recipient.
//
// Returns:
//   {ok:true, artifact_path, signature_ok, recipient_ok, manifest,
//    signer_fpr, recipient_fpr, version}
//   {ok:false, error, detail, version}
//
// Args:
//   bundle_path           tarball produced by createSneakernetBundle
//   trusted_pubkey_path   local file holding the signer's Ed25519 public key
//                         (PEM or raw 32 bytes). The receiver MUST have this
//                         out-of-band — sneakernet does NOT bootstrap trust.
//   extract_to            optional dir to extract artifact.kolm into; if
//                         signature_ok && recipient_ok the artifact is written
//                         there; otherwise NOT (refuses to let unverified
//                         bytes escape the verifier).
export function verifySneakernetBundle(opts = {}) {
  const {
    bundle_path,
    trusted_pubkey_path,
    extract_to = null,
  } = opts || {};
  if (!bundle_path) {
    return { ok: false, error: 'bundle_path_required', version: AIRGAP_SNEAKERNET_VERSION };
  }
  if (!trusted_pubkey_path) {
    return { ok: false, error: 'trusted_pubkey_path_required', version: AIRGAP_SNEAKERNET_VERSION };
  }
  if (!fs.existsSync(bundle_path)) {
    return {
      ok: false,
      error: 'bundle_not_found',
      bundle_path,
      version: AIRGAP_SNEAKERNET_VERSION,
    };
  }
  if (!fs.existsSync(trusted_pubkey_path)) {
    return {
      ok: false,
      error: 'trusted_pubkey_not_found',
      trusted_pubkey_path,
      version: AIRGAP_SNEAKERNET_VERSION,
    };
  }

  let tarBuf;
  try {
    tarBuf = fs.readFileSync(bundle_path);
  } catch (e) {
    return {
      ok: false,
      error: 'bundle_read_error',
      detail: String((e && e.message) || e),
      version: AIRGAP_SNEAKERNET_VERSION,
    };
  }

  let entries;
  try {
    entries = parseTarArchive(tarBuf);
  } catch (e) {
    return {
      ok: false,
      error: 'bundle_parse_error',
      detail: String((e && e.message) || e),
      version: AIRGAP_SNEAKERNET_VERSION,
    };
  }
  const byName = {};
  for (const ent of entries) byName[ent.name] = ent.body;
  for (const required of ['artifact.kolm', 'manifest.json', 'signature.bin', 'kolm-airgap-receipt.json']) {
    if (!byName[required]) {
      return {
        ok: false,
        error: 'bundle_missing_entry',
        missing: required,
        present: entries.map((e) => e.name),
        version: AIRGAP_SNEAKERNET_VERSION,
      };
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(byName['manifest.json'].toString('utf8'));
  } catch (e) {
    return {
      ok: false,
      error: 'manifest_parse_error',
      detail: String((e && e.message) || e),
      version: AIRGAP_SNEAKERNET_VERSION,
    };
  }

  let trustedPub;
  try {
    trustedPub = loadPublicKey(trusted_pubkey_path);
  } catch (e) {
    return {
      ok: false,
      error: 'trusted_pubkey_load_error',
      detail: String((e && e.message) || e),
      version: AIRGAP_SNEAKERNET_VERSION,
    };
  }
  const trustedFpr = pubKeyFingerprint(trustedPub);

  // Recompute the canonical signing payload exactly as createSneakernetBundle did.
  const manifestCanonical = canonicalManifestJson(manifest);
  const payload = signingPayload(byName['artifact.kolm'], manifestCanonical);
  const signature = byName['signature.bin'];

  let signature_ok = false;
  try {
    signature_ok = crypto.verify(null, payload, trustedPub, signature) === true;
  } catch (_) {
    // Malformed signature or wrong algorithm — fail closed.
    signature_ok = false;
  }

  // Recipient match: the trusted pubkey (the verifier's identity) MUST equal
  // the manifest's recipient_pubkey_b64. If the manifest carries no recipient
  // (single-key flow), recipient_ok is determined by signer == trusted.
  const trustedB64 = publicKeyToRawB64(trustedPub);
  let recipient_ok;
  if (manifest.recipient_pubkey_b64) {
    recipient_ok = manifest.recipient_pubkey_b64 === trustedB64;
  } else {
    // Single-key flow: recipient_ok iff trusted == signer.
    recipient_ok = manifest.signer_pubkey_b64 === trustedB64;
  }

  const signer_fpr = manifest.signer_pubkey_b64
    ? sha256Hex(Buffer.from(manifest.signer_pubkey_b64, 'base64')).slice(0, 32)
    : null;
  const recipient_fpr = manifest.recipient_pubkey_b64
    ? sha256Hex(Buffer.from(manifest.recipient_pubkey_b64, 'base64')).slice(0, 32)
    : null;

  // Write the artifact ONLY when both gates are green. Honesty contract:
  // unverified bytes MUST NOT escape past the verifier.
  let artifact_path = null;
  if (extract_to && signature_ok && recipient_ok) {
    try {
      fs.mkdirSync(extract_to, { recursive: true });
      artifact_path = path.join(
        extract_to,
        String(manifest.artifact_id || 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_') + '.kolm'
      );
      fs.writeFileSync(artifact_path, byName['artifact.kolm']);
    } catch (e) {
      return {
        ok: false,
        error: 'extract_write_error',
        detail: String((e && e.message) || e),
        signature_ok,
        recipient_ok,
        manifest,
        version: AIRGAP_SNEAKERNET_VERSION,
      };
    }
  }

  return {
    ok: true,
    artifact_path,
    signature_ok,
    recipient_ok,
    trustworthy: signature_ok && recipient_ok,
    manifest,
    signer_fpr,
    recipient_fpr,
    trusted_fpr: trustedFpr,
    sha256_artifact: sha256Hex(byName['artifact.kolm']),
    sha256_artifact_expected: manifest.sha256_artifact,
    version: AIRGAP_SNEAKERNET_VERSION,
  };
}

// Exposed for tests + downstream consumers that want to mint Ed25519 key
// material without shelling out to openssl. Returns {private_key_pem,
// public_key_pem, fingerprint}.
export function generateEd25519Keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    private_key_pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    public_key_pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    fingerprint: pubKeyFingerprint(publicKey),
  };
}

export const _internal = {
  buildTarArchive,
  parseTarArchive,
  canonicalManifestJson,
  signingPayload,
  pubKeyFingerprint,
  loadPublicKey,
  loadSigningKey,
};
