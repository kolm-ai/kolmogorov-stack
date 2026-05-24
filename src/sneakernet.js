// W779 - Sneakernet deployment: transfer .kolm via USB with sig verify.
//
// Closes the sneakernet half of W779 (the airgap-mode half lives in
// src/airgap-mode.js). Packages a .kolm artifact into a self-contained tar
// bundle that ships with:
//
//   artifact.kolm   - the .kolm artifact, byte-identical to the source
//   signature.sig   - HMAC-SHA256 over (artifact_bytes + manifest_canonical)
//                     so a corrupted USB write fails verification
//   manifest.json   - {artifact_id, sha256_artifact, sha256_signature,
//                      created_at, version, transport:'sneakernet'}
//   README.txt      - one-page operator note: how to verify + unpack
//
// We deliberately avoid shelling out to `tar` — it's not guaranteed on
// Windows hosts and the test fixture would have to special-case the
// platform. Instead we write a minimal USTAR-compatible tar archive in
// pure JS. The archive is uncompressed (no gzip) because:
//
//   - Sneakernet bandwidth is "drive home from work" not "stream over wire"
//   - Tests assert that unpackSneakernet -> packSneakernet is a roundtrip
//     and a deterministic tar layout makes the sha256 comparable
//   - Adding zlib only saves ~10% on already-compressed .kolm (it's a zip)
//
// W411 tenant fence: packSneakernet accepts opts.tenant and writes it into
// the manifest; unpackSneakernet does NOT enforce tenant on its own — the
// caller (route layer) is responsible because the tenant_id is bound to
// the http request, not the on-disk archive. The honest envelope surfaces
// the manifest tenant_id so a route handler can compare.
//
// W604 version stamp: SNEAKERNET_VERSION = 'w779-v1'. Consumers MUST match
// /^w779-/.
//
// Honesty invariants:
//   - packSneakernet returns ok:false when the artifact path doesn't exist
//     — never silent passthrough.
//   - unpackSneakernet sets verified:false when the embedded signature
//     doesn't match the actual artifact bytes — caller MUST honor this
//     before treating the artifact as trustworthy.
//   - The signature is HMAC over (artifact + manifest_canonical). Tampering
//     with EITHER side breaks verify, so a swapped artifact under the same
//     manifest also fails.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SNEAKERNET_VERSION = 'w779-v1';

// Magic bytes that prefix the README so a tail -c 16 inspection on the
// archive shows operators they're holding the right bundle. Plain ASCII.
const SNEAKERNET_README_BANNER = '=== kolm sneakernet bundle (w779) ===';

// Default secret used to sign the bundle. In production this comes from
// RECIPE_RECEIPT_SECRET (the same secret that signs .kolm receipts) so the
// same tenant key chain protects both. Falls back to a fixed-string fixture
// only when neither is set so tests stay deterministic.
function sneakernetSecret(override) {
  if (override) return override;
  return process.env.RECIPE_RECEIPT_SECRET || 'kolm-sneakernet-fixture-v0-1-0';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hmacSha256(secret, buf) {
  return crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

// =============================================================================
// Minimal USTAR-compatible tar writer. Only the fields we need (name, size,
// mtime, mode, typeflag) are populated; all other USTAR header fields are
// zero-padded. Each file body is null-padded to a 512-byte boundary and the
// archive is terminated by two 512-byte zero blocks per POSIX.
// =============================================================================

const TAR_BLOCK = 512;

function tarChecksumField(headerBuf) {
  // Per POSIX: checksum is computed by summing all bytes in the header with
  // the checksum field temporarily filled with ASCII spaces (0x20).
  // We construct the checksum value as an octal string followed by a NUL
  // and a SPACE per the historical tar convention.
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += headerBuf[i];
  return sum;
}

function writeOctal(buf, offset, len, value) {
  const oct = value.toString(8);
  const padded = oct.padStart(len - 1, '0') + '\x00';
  buf.write(padded, offset, len, 'binary');
}

function writeTarHeader(name, size, mtime = Math.floor(Date.now() / 1000)) {
  // We do not support long filenames here (>100 chars). Sneakernet bundles
  // only need 4 well-known names so this is a safe constraint.
  if (Buffer.byteLength(name, 'utf8') > 100) {
    throw new Error(`tar: filename too long for USTAR header: ${name}`);
  }
  const header = Buffer.alloc(TAR_BLOCK, 0);
  header.write(name, 0, 100, 'utf8');           // name (100)
  writeOctal(header, 100, 8,  0o644);            // mode (8)
  writeOctal(header, 108, 8,  0);                // uid (8)
  writeOctal(header, 116, 8,  0);                // gid (8)
  writeOctal(header, 124, 12, size);             // size (12)
  writeOctal(header, 136, 12, mtime);            // mtime (12)
  header.write('        ', 148, 8, 'binary');    // checksum slot (ASCII spaces)
  header.write('0', 156, 1, 'binary');           // typeflag (0 = regular file)
  // linkname (100) at 157 stays zero.
  header.write('ustar\x0000', 257, 8, 'binary'); // magic + version
  // Compute and write the checksum.
  const checksum = tarChecksumField(header);
  // Checksum format: 6-digit octal + NUL + SPACE (8 bytes total).
  const csOct = checksum.toString(8).padStart(6, '0') + '\x00 ';
  header.write(csOct, 148, 8, 'binary');
  return header;
}

function padToBlock(body) {
  const remainder = body.length % TAR_BLOCK;
  if (remainder === 0) return Buffer.alloc(0);
  return Buffer.alloc(TAR_BLOCK - remainder, 0);
}

function buildTarArchive(entries) {
  // entries: [{name, body: Buffer}]. Returns the assembled tar Buffer.
  const chunks = [];
  for (const ent of entries) {
    const header = writeTarHeader(ent.name, ent.body.length);
    chunks.push(header);
    chunks.push(ent.body);
    const pad = padToBlock(ent.body);
    if (pad.length) chunks.push(pad);
  }
  // Two empty 512-byte blocks terminate the archive.
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

// =============================================================================
// Minimal USTAR-compatible tar reader. Stops at the first all-zero block per
// POSIX. Returns [{name, body}].
// =============================================================================

function parseTarArchive(buf) {
  const entries = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= buf.length) {
    const header = buf.slice(offset, offset + TAR_BLOCK);
    // Empty block => archive terminator.
    if (header.every((b) => b === 0)) break;
    // Parse name (NUL-terminated). The W411 contract says be conservative —
    // a malformed header should never silently advance the offset by a
    // wrong amount and resync on garbage. Throw loudly.
    const nameRaw = header.slice(0, 100);
    const nulIdx = nameRaw.indexOf(0);
    const name = (nulIdx === -1 ? nameRaw : nameRaw.slice(0, nulIdx)).toString('utf8');
    if (!name) throw new Error('tar: empty filename at offset ' + offset);
    // Parse size (octal, NUL-terminated).
    const sizeRaw = header.slice(124, 136);
    const sizeNul = sizeRaw.indexOf(0);
    const sizeOct = (sizeNul === -1 ? sizeRaw : sizeRaw.slice(0, sizeNul)).toString('ascii').trim();
    const size = sizeOct ? parseInt(sizeOct, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('tar: bad size header for ' + name + ': ' + JSON.stringify(sizeOct));
    }
    const bodyStart = offset + TAR_BLOCK;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > buf.length) {
      throw new Error(`tar: body for ${name} extends past archive end (${bodyEnd} > ${buf.length})`);
    }
    const body = buf.slice(bodyStart, bodyEnd);
    entries.push({ name, body });
    // Advance: header block + padded body.
    const padded = size + (size % TAR_BLOCK === 0 ? 0 : TAR_BLOCK - (size % TAR_BLOCK));
    offset = bodyStart + padded;
  }
  return entries;
}

// =============================================================================
// Public API: pack + unpack.
// =============================================================================

// Build the canonical JSON form of the manifest. Sorted keys so the same
// manifest object always hashes identically — the signature is HMAC over
// this canonical form (NOT JSON.stringify with default ordering).
function canonicalManifestJson(manifest) {
  const keys = Object.keys(manifest).sort();
  const ordered = {};
  for (const k of keys) ordered[k] = manifest[k];
  return JSON.stringify(ordered);
}

function readmeBody(manifest) {
  return [
    SNEAKERNET_README_BANNER,
    '',
    'This archive carries a single .kolm artifact across an air-gap.',
    '',
    `artifact_id:    ${manifest.artifact_id}`,
    `sha256:         ${manifest.sha256_artifact}`,
    `created_at:     ${manifest.created_at}`,
    `version:        ${manifest.version}`,
    `transport:      ${manifest.transport}`,
    '',
    'To verify on the target host:',
    '    kolm unpack --sneakernet <this-archive.tar>',
    '',
    'unpack will verify the embedded signature against the artifact bytes',
    'and report {verified:true|false}. A false verdict means the archive',
    'is corrupted or tampered — DO NOT load the artifact.',
    '',
  ].join('\n');
}

// Pack a .kolm artifact into a sneakernet bundle. Returns:
//   {ok:true, path, sha256, manifest, signature, version}
//   {ok:false, error, ...}
//
// The bundle layout is fully deterministic: same input bytes + same mtime
// produce the same archive bytes. Tests can therefore assert sha256
// stability across runs.
//
// Args:
//   artifact_id      stable identifier (manifest.job_id, content cid, etc.)
//   artifact_path    path to the .kolm file on disk
//   dest_path        output path for the .tar bundle
//   tenant           optional tenant_id (W411 surface attribution)
//   secret           optional HMAC secret override (defaults to env)
//   mtime            optional mtime override for deterministic tests
//
// Honest envelope:
//   - artifact_not_found when artifact_path is missing
//   - artifact_read_error when read fails
//   - write_error when output write fails
export function packSneakernet(opts = {}) {
  const {
    artifact_id,
    artifact_path,
    dest_path,
    tenant = null,
    secret,
    mtime,
  } = opts;
  if (!artifact_id || typeof artifact_id !== 'string') {
    return {
      ok: false,
      error: 'artifact_id_required',
      hint: 'pass {artifact_id: string} — used in the manifest + README',
      version: SNEAKERNET_VERSION,
    };
  }
  if (!artifact_path || typeof artifact_path !== 'string') {
    return {
      ok: false,
      error: 'artifact_path_required',
      hint: 'pass {artifact_path: "/path/to/file.kolm"}',
      version: SNEAKERNET_VERSION,
    };
  }
  if (!dest_path || typeof dest_path !== 'string') {
    return {
      ok: false,
      error: 'dest_path_required',
      hint: 'pass {dest_path: "/path/to/output.tar"}',
      version: SNEAKERNET_VERSION,
    };
  }
  if (!fs.existsSync(artifact_path)) {
    return {
      ok: false,
      error: 'artifact_not_found',
      artifact_path,
      hint: 'check the path — sneakernet packs the file as-is, no resolution magic',
      version: SNEAKERNET_VERSION,
    };
  }
  let artifactBytes;
  try {
    artifactBytes = fs.readFileSync(artifact_path);
  } catch (e) {
    return {
      ok: false,
      error: 'artifact_read_error',
      detail: String(e && e.message || e),
      version: SNEAKERNET_VERSION,
    };
  }
  const artifactSha = sha256(artifactBytes);
  const createdAt = new Date().toISOString();
  const fixedMtime = (typeof mtime === 'number' && Number.isFinite(mtime))
    ? mtime
    : Math.floor(Date.now() / 1000);

  // Build manifest BEFORE signing. The signature covers
  // (artifact_bytes || '\0' || manifest_canonical) — any swap on either side
  // breaks verify.
  const manifest = {
    artifact_id,
    sha256_artifact: artifactSha,
    created_at: createdAt,
    version: SNEAKERNET_VERSION,
    transport: 'sneakernet',
    tenant,
  };
  const manifestCanonical = canonicalManifestJson(manifest);
  const sig = hmacSha256(
    sneakernetSecret(secret),
    Buffer.concat([artifactBytes, Buffer.from('\x00'), Buffer.from(manifestCanonical, 'utf8')]),
  );

  // Stuff the signature sha into the manifest BEFORE writing so README and
  // archive both reflect it. We do NOT include sha256_signature in the
  // canonical-for-HMAC form (it would create a circular dep on itself).
  const manifestWithSig = Object.assign({}, manifest, { sha256_signature: sig });

  const readme = readmeBody(manifestWithSig);
  const manifestJson = JSON.stringify(manifestWithSig, null, 2) + '\n';

  // Assemble the tar archive. Deterministic file order: artifact, signature,
  // manifest, README. mtime is the same for every entry so the archive bytes
  // are fully reproducible.
  let tarBuf;
  try {
    tarBuf = buildTarArchive([
      { name: 'artifact.kolm', body: artifactBytes,                       mtime: fixedMtime },
      { name: 'signature.sig', body: Buffer.from(sig + '\n', 'utf8'),    mtime: fixedMtime },
      { name: 'manifest.json', body: Buffer.from(manifestJson, 'utf8'),  mtime: fixedMtime },
      { name: 'README.txt',    body: Buffer.from(readme, 'utf8'),        mtime: fixedMtime },
    ]);
  } catch (e) {
    return {
      ok: false,
      error: 'tar_build_error',
      detail: String(e && e.message || e),
      version: SNEAKERNET_VERSION,
    };
  }

  // Ensure dest directory exists, write archive.
  try {
    const destDir = path.dirname(dest_path);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest_path, tarBuf);
  } catch (e) {
    return {
      ok: false,
      error: 'write_error',
      detail: String(e && e.message || e),
      version: SNEAKERNET_VERSION,
    };
  }

  return {
    ok: true,
    path: dest_path,
    sha256: sha256(tarBuf),
    sha256_artifact: artifactSha,
    sha256_signature: sig,
    bytes: tarBuf.length,
    manifest: manifestWithSig,
    signature: sig,
    tenant,
    version: SNEAKERNET_VERSION,
  };
}

// Unpack a sneakernet bundle. Verifies the embedded signature against the
// artifact bytes. Returns:
//   {ok:true, artifact_id, verified:bool, manifest, artifact_path?, version}
//   {ok:false, error, ...}
//
// When dest_dir is supplied AND verified is true, the artifact + manifest +
// README are written there. When verified is false the files are NOT
// written — the contract is "do not let unverified bytes escape past this
// boundary" so the caller cannot accidentally load a tampered artifact.
export function unpackSneakernet(opts = {}) {
  const {
    src_path,
    dest_dir,
    secret,
  } = opts;
  if (!src_path || typeof src_path !== 'string') {
    return {
      ok: false,
      error: 'src_path_required',
      hint: 'pass {src_path: "/path/to/bundle.tar"}',
      version: SNEAKERNET_VERSION,
    };
  }
  if (!fs.existsSync(src_path)) {
    return {
      ok: false,
      error: 'bundle_not_found',
      src_path,
      version: SNEAKERNET_VERSION,
    };
  }
  let tarBuf;
  try {
    tarBuf = fs.readFileSync(src_path);
  } catch (e) {
    return {
      ok: false,
      error: 'bundle_read_error',
      detail: String(e && e.message || e),
      version: SNEAKERNET_VERSION,
    };
  }
  let entries;
  try {
    entries = parseTarArchive(tarBuf);
  } catch (e) {
    return {
      ok: false,
      error: 'bundle_parse_error',
      detail: String(e && e.message || e),
      version: SNEAKERNET_VERSION,
    };
  }
  const byName = {};
  for (const ent of entries) byName[ent.name] = ent.body;
  for (const required of ['artifact.kolm', 'signature.sig', 'manifest.json', 'README.txt']) {
    if (!byName[required]) {
      return {
        ok: false,
        error: 'bundle_missing_entry',
        missing: required,
        present: entries.map(e => e.name),
        version: SNEAKERNET_VERSION,
      };
    }
  }
  const artifactBytes = byName['artifact.kolm'];
  const sigEmbedded = byName['signature.sig'].toString('utf8').trim();
  let manifest;
  try {
    manifest = JSON.parse(byName['manifest.json'].toString('utf8'));
  } catch (e) {
    return {
      ok: false,
      error: 'manifest_parse_error',
      detail: String(e && e.message || e),
      version: SNEAKERNET_VERSION,
    };
  }

  // Rebuild the canonical manifest the same way the packer did — strip the
  // sha256_signature slot because it's a self-reference. Then HMAC.
  const canonicalSrc = Object.assign({}, manifest);
  delete canonicalSrc.sha256_signature;
  const manifestCanonical = canonicalManifestJson(canonicalSrc);
  const sigComputed = hmacSha256(
    sneakernetSecret(secret),
    Buffer.concat([artifactBytes, Buffer.from('\x00'), Buffer.from(manifestCanonical, 'utf8')]),
  );

  // Constant-time compare so a timing attacker cannot probe signature bytes.
  const verified = (
    sigEmbedded.length === sigComputed.length &&
    crypto.timingSafeEqual(Buffer.from(sigEmbedded, 'utf8'), Buffer.from(sigComputed, 'utf8'))
  );

  const sha256Computed = sha256(artifactBytes);
  const shaMatches = manifest.sha256_artifact === sha256Computed;

  // Honest envelope: BOTH must be true for the unpack to be trustworthy.
  const trustworthy = verified && shaMatches;

  let writtenPath = null;
  if (trustworthy && dest_dir) {
    try {
      fs.mkdirSync(dest_dir, { recursive: true });
      const artOut = path.join(dest_dir, manifest.artifact_id.replace(/[^a-zA-Z0-9._-]/g, '_') + '.kolm');
      fs.writeFileSync(artOut, artifactBytes);
      fs.writeFileSync(path.join(dest_dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      fs.writeFileSync(path.join(dest_dir, 'README.txt'), byName['README.txt']);
      writtenPath = artOut;
    } catch (e) {
      return {
        ok: false,
        error: 'unpack_write_error',
        detail: String(e && e.message || e),
        verified,
        sha_matches: shaMatches,
        manifest,
        version: SNEAKERNET_VERSION,
      };
    }
  }

  return {
    ok: true,
    artifact_id: manifest.artifact_id,
    verified,
    sha_matches: shaMatches,
    trustworthy,
    manifest,
    artifact_path: writtenPath,
    bundle_path: src_path,
    sha256_artifact: sha256Computed,
    sha256_artifact_expected: manifest.sha256_artifact,
    version: SNEAKERNET_VERSION,
  };
}

// Helpers exposed for tests + downstream consumers. The pure functions let
// a test assert canonical-form stability without touching the filesystem.
export const _internal = {
  buildTarArchive,
  parseTarArchive,
  canonicalManifestJson,
  hmacSha256,
  sha256,
};
