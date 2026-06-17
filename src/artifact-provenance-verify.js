// src/artifact-provenance-verify.js
//
// C7 - verifier-from-signer for final .kolm provenance sidecars.
// Reads the artifact ZIP bytes, derives the Ed25519 public key from the signed
// receipt, and verifies the SLSA DSSE + OMS sidecars against the actual member
// bytes in that artifact. This closes the gap between in-memory sidecar tests
// and the packaged artifact a buyer receives.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { canonicalJson } from './cid.js';
import { verifySignatureBlock as verifyEd25519Block, keyFingerprint } from './ed25519.js';
import { verifyInTotoAgainstArtifact, verifyDsseEnvelope } from './intoto-slsa.js';
import { verifyInTotoBundle } from './intoto-receipt.js';
import { listEntriesFromLargeZip, readEntryFromLargeZip, extractEntryToFile } from './zip-large.js';

export const ARTIFACT_PROVENANCE_SEAL_FILES = new Set([
  'signature.sig',
  'receipt.json',
  'credential.json',
  'provenance.intoto.dsse.json',
  'model.sig.bundle',
]);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseJsonEntry(entries, name) {
  const buf = entries[name];
  if (!buf) throw new Error(`missing ${name}`);
  return JSON.parse(buf.toString('utf8'));
}

function readZipEntries(artifactPath) {
  const zip = new AdmZip(artifactPath);
  const entries = {};
  for (const e of zip.getEntries()) {
    if (!e.isDirectory) entries[e.entryName] = e.getData();
  }
  return entries;
}

async function readLargeZipEntriesAndDigests(artifactPath) {
  const listed = listEntriesFromLargeZip(artifactPath).slice().sort((a, b) => a.name.localeCompare(b.name));
  const entries = {};
  const digests = {};
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-c7-provenance-'));
  try {
    for (const ent of listed) {
      if (!ent || !ent.name) continue;
      if (ARTIFACT_PROVENANCE_SEAL_FILES.has(ent.name)) {
        const buf = readEntryFromLargeZip(artifactPath, ent.name);
        if (buf) entries[ent.name] = buf;
        continue;
      }
      if (ent.uncompressed_size > 2 * 1024 * 1024 * 1024 - 1) {
        const dest = path.join(tmpDir, crypto.randomBytes(8).toString('hex'));
        const res = await extractEntryToFile(artifactPath, ent.name, dest, { computeSha256: true });
        if (!res.ok) throw new Error(`could not hash large entry ${ent.name}: ${res.reason}`);
        digests[ent.name] = res.sha256;
      } else {
        const buf = readEntryFromLargeZip(artifactPath, ent.name);
        if (buf) digests[ent.name] = sha256(buf);
      }
    }
    return { entries, digests };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function memberDigestMap(entries) {
  const out = {};
  for (const name of Object.keys(entries).sort()) {
    if (ARTIFACT_PROVENANCE_SEAL_FILES.has(name)) continue;
    out[name] = sha256(entries[name]);
  }
  return out;
}

function exactSubjectCoverage(statement, digestMap) {
  const subjects = Array.isArray(statement && statement.subject) ? statement.subject : [];
  const seen = new Set();
  const got = [];
  for (const s of subjects) {
    if (!s || typeof s.name !== 'string' || s.name.length === 0) {
      return { ok: false, reason: 'subject missing name' };
    }
    if (seen.has(s.name)) return { ok: false, reason: `duplicate subject ${s.name}` };
    seen.add(s.name);
    got.push(s.name);
  }
  const want = Object.keys(digestMap).sort();
  got.sort();
  if (got.length !== want.length) {
    return { ok: false, reason: `subject count ${got.length} != artifact member count ${want.length}` };
  }
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i]) {
      return { ok: false, reason: `subject set mismatch at ${i}: got ${got[i] || '<missing>'}, want ${want[i]}` };
    }
  }
  return { ok: true, subjects_total: got.length };
}

function verifyReceiptSigner(receipt) {
  const block = receipt && receipt.signature_ed25519;
  if (!block || typeof block.public_key !== 'string') {
    return { ok: false, reason: 'receipt.signature_ed25519.public_key missing' };
  }
  const { signature_ed25519, signature_sigstore, ...payload } = receipt;
  void signature_ed25519; void signature_sigstore;
  const verified = verifyEd25519Block(block, canonicalJson(payload));
  if (!verified.ok) return { ok: false, reason: `receipt Ed25519 verification failed: ${verified.reason}` };
  let fp = verified.key_fingerprint;
  if (!fp) {
    try { fp = keyFingerprint(block.public_key); } catch { fp = undefined; }
  }
  return { ok: true, publicKey: block.public_key, key_fingerprint: fp };
}

function decodeDsseStatement(envelope) {
  const payload = envelope && envelope.payload;
  if (typeof payload !== 'string') throw new Error('DSSE payload missing');
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

function verifyFromEntriesAndDigests(entries, digests, opts) {
  const requireSidecars = opts.requireSidecars !== false;
  const hasSlsa = !!entries['provenance.intoto.dsse.json'];
  const hasOms = !!entries['model.sig.bundle'];
  if (!hasSlsa || !hasOms) {
    const reason = `provenance sidecars missing: slsa=${hasSlsa}, oms=${hasOms}`;
    return requireSidecars
      ? { ok: false, reason, present: false }
      : { ok: true, reason, present: false, slsa: null, oms: null };
  }

  const receipt = parseJsonEntry(entries, 'receipt.json');
  const signer = verifyReceiptSigner(receipt);
  if (!signer.ok) return { ok: false, reason: signer.reason, present: true };

  const slsaEnvelope = parseJsonEntry(entries, 'provenance.intoto.dsse.json');
  const slsa = verifyInTotoAgainstArtifact(slsaEnvelope, digests, { publicKey: signer.publicKey });
  const slsaStatement = decodeDsseStatement(slsaEnvelope);
  const slsaCoverage = exactSubjectCoverage(slsaStatement, digests);
  if (!slsa.ok) return { ok: false, reason: `SLSA sidecar failed: ${slsa.reason}`, present: true, slsa, oms: null };
  if (!slsaCoverage.ok) return { ok: false, reason: `SLSA sidecar failed: ${slsaCoverage.reason}`, present: true, slsa, oms: null };

  const omsBundle = parseJsonEntry(entries, 'model.sig.bundle');
  const oms = verifyInTotoBundle(omsBundle, { publicKey: signer.publicKey, subjectDigestMap: digests });
  if (!oms.ok) return { ok: false, reason: `OMS sidecar failed: ${oms.reason}`, present: true, slsa, oms };
  const omsCoverage = exactSubjectCoverage(oms.statement, digests);
  if (!omsCoverage.ok) return { ok: false, reason: `OMS sidecar failed: ${omsCoverage.reason}`, present: true, slsa, oms };

  const slsaSig = verifyDsseEnvelope(slsaEnvelope, { publicKey: signer.publicKey });
  return {
    ok: true,
    present: true,
    key_fingerprint: signer.key_fingerprint || slsaSig.key_fingerprint || oms.key_fingerprint,
    subjects_total: Object.keys(digests).length,
    slsa: {
      ok: true,
      predicateType: slsa.predicateType,
      subjects_matched: slsa.subjects_matched,
      subjects_total: slsa.subjects_total,
    },
    oms: {
      ok: true,
      predicateType: oms.predicateType,
      subjects_matched: oms.subjects_matched,
      subjects_total: oms.subjects_total,
    },
  };
}

export function verifyArtifactProvenanceSidecars(artifactPath, opts = {}) {
  try {
    if (!artifactPath || typeof artifactPath !== 'string') {
      return { ok: false, reason: 'artifactPath required' };
    }
    const entries = readZipEntries(artifactPath);
    return verifyFromEntriesAndDigests(entries, memberDigestMap(entries), opts);
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

export async function verifyArtifactProvenanceSidecarsAsync(artifactPath, opts = {}) {
  try {
    if (!artifactPath || typeof artifactPath !== 'string') {
      return { ok: false, reason: 'artifactPath required' };
    }
    const stat = fs.statSync(artifactPath);
    if (stat.size <= 2 * 1024 * 1024 * 1024 - 1) {
      return verifyArtifactProvenanceSidecars(artifactPath, opts);
    }
    const { entries, digests } = await readLargeZipEntriesAndDigests(artifactPath);
    return verifyFromEntriesAndDigests(entries, digests, opts);
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

export default verifyArtifactProvenanceSidecars;
