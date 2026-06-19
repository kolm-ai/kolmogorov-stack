// src/sigstore-keyless.js
//
// W1027 - optional Sigstore keyless/Fulcio policy verifier.
//
// This module is deliberately offline and fail-closed. It does not mint
// Fulcio certificates and it does not fetch TUF roots. Instead it verifies a
// bundle against operator-pinned Fulcio root material, exact OIDC
// issuer/identity rules, and Rekor transparency-log evidence. That gives
// Kolm a real keyless verification option without upgrading the default
// Ed25519 model-artifact profile into a SLSA Build L3 claim.

import crypto, { X509Certificate } from 'node:crypto';

export const SIGSTORE_KEYLESS_POLICY_VERSION = 'w1027-sigstore-keyless-policy-v1';
export const SIGSTORE_KEYLESS_CLAIM_SCOPE = 'optional_fulcio_oidc_policy_offline';
export const SIGSTORE_KEYLESS_DESCRIPTOR_FIXTURE_SCOPE = 'descriptor_fixture_policy_only';

export const FULCIO_OIDC_ISSUER_OID = '1.3.6.1.4.1.57264.1.1';
export const FULCIO_GITHUB_WORKFLOW_TRIGGER_OID = '1.3.6.1.4.1.57264.1.2';
export const FULCIO_GITHUB_WORKFLOW_SHA_OID = '1.3.6.1.4.1.57264.1.3';
export const FULCIO_GITHUB_WORKFLOW_NAME_OID = '1.3.6.1.4.1.57264.1.4';
export const FULCIO_GITHUB_WORKFLOW_REPOSITORY_OID = '1.3.6.1.4.1.57264.1.5';
export const FULCIO_GITHUB_WORKFLOW_REF_OID = '1.3.6.1.4.1.57264.1.6';

const HEX64_RE = /^[0-9a-f]{64}$/;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const s = cleanString(value);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function normalizeSha256Pin(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  const stripped = raw
    .replace(/^sha256[:=]/i, '')
    .replace(/^sha256 fingerprint=/i, '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  return HEX64_RE.test(stripped) ? stripped : null;
}

export function fingerprintChainMaterial(value) {
  if (Buffer.isBuffer(value)) return sha256Hex(value);
  if (value instanceof Uint8Array) return sha256Hex(Buffer.from(value));
  if (value && typeof value === 'object') {
    const candidate = value.raw || value.rawBytes || value.der || value.pem || value.certificate;
    if (candidate != null && candidate !== value) return fingerprintChainMaterial(candidate);
    return sha256Hex(Buffer.from(JSON.stringify(value), 'utf8'));
  }
  return sha256Hex(Buffer.from(String(value ?? ''), 'utf8'));
}

function normalizeUrlLike(value) {
  const s = cleanString(value);
  if (!s) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    u.search = '';
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString().replace(/\/$/, '');
  } catch {
    return s;
  }
}

function normalizeIdentity(value) {
  const s = cleanString(value);
  if (!s) return '';
  if (/^mailto:/i.test(s)) return 'mailto:' + s.slice(7).toLowerCase();
  if (/^[^@\s]+@[^@\s]+$/.test(s)) return s.toLowerCase();
  return normalizeUrlLike(s);
}

function normalizeIssuer(value) {
  return normalizeUrlLike(value);
}

function collectStrings(...values) {
  const out = [];
  for (const value of values) {
    if (Array.isArray(value)) out.push(...value);
    else if (value != null) out.push(value);
  }
  return unique(out.map((v) => String(v)));
}

export function buildFulcioKeylessPolicy(input = {}) {
  const issuers = collectStrings(input.issuer, input.issuers, input.oidc_issuer, input.oidcIssuers)
    .map(normalizeIssuer)
    .filter(Boolean);
  const identities = collectStrings(
    input.identity,
    input.identities,
    input.subject,
    input.subjects,
    input.san,
    input.sans,
  ).map(normalizeIdentity).filter(Boolean);

  const rootPins = collectStrings(
    input.fulcioRootSha256,
    input.fulcio_root_sha256,
    input.fulcioRootPins,
    input.fulcio_root_pins,
    input.rootPins,
    input.root_pins,
  ).map(normalizeSha256Pin).filter(Boolean);

  const rootMaterialPins = asArray(input.fulcioRootMaterial || input.fulcio_root_material)
    .map(fingerprintChainMaterial)
    .filter(Boolean);

  const rekorLogIds = collectStrings(input.rekorLogId, input.rekor_log_id, input.rekorLogIds, input.rekor_log_ids)
    .map((v) => cleanString(v).toLowerCase())
    .filter(Boolean);

  const failures = [];
  if (issuers.length === 0) failures.push('oidc_issuer_required');
  if (identities.length === 0) failures.push('oidc_identity_required');
  if (rootPins.length === 0 && rootMaterialPins.length === 0) failures.push('fulcio_root_pin_required');

  return {
    version: SIGSTORE_KEYLESS_POLICY_VERSION,
    ok: failures.length === 0,
    issuers: unique(issuers),
    identities: unique(identities),
    fulcio_root_sha256: unique([...rootPins, ...rootMaterialPins]),
    rekor_log_ids: unique(rekorLogIds),
    require_rekor: input.requireRekor !== false && input.require_rekor !== false,
    require_rekor_inclusion: input.requireRekorInclusion !== false && input.require_rekor_inclusion !== false,
    require_certificate_chain: input.requireCertificateChain !== false && input.require_certificate_chain !== false,
    allow_descriptor_fixture: input.allowDescriptorFixture === true || input.allow_descriptor_fixture === true,
    builder_id: cleanString(input.builderId || input.builder_id) || null,
    source_repository: cleanString(input.sourceRepository || input.source_repository) || null,
    workflow_ref: cleanString(input.workflowRef || input.workflow_ref) || null,
    workflow_sha: cleanString(input.workflowSha || input.workflow_sha) || null,
    failures,
  };
}

function rawBytesFromCertish(certish) {
  if (!certish) return null;
  if (Buffer.isBuffer(certish)) return certish;
  if (certish instanceof Uint8Array) return Buffer.from(certish);
  if (typeof certish === 'string') return Buffer.from(certish, 'utf8');
  for (const key of ['raw', 'rawBytes', 'der', 'bytes']) {
    const v = certish[key];
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v);
    if (typeof v === 'string' && v.length > 0) {
      if (/-----BEGIN CERTIFICATE-----/.test(v)) return Buffer.from(v, 'utf8');
      try { return Buffer.from(v, 'base64'); } catch { return Buffer.from(v, 'utf8'); }
    }
  }
  if (typeof certish.pem === 'string') return Buffer.from(certish.pem, 'utf8');
  if (typeof certish.certificate === 'string') return Buffer.from(certish.certificate, 'utf8');
  return null;
}

function tryX509(certish) {
  const raw = rawBytesFromCertish(certish);
  if (!raw || raw.length === 0) return null;
  try { return new X509Certificate(raw); } catch { return null; }
}

function parseSubjectAltName(value) {
  const s = cleanString(value);
  if (!s) return [];
  return unique(s.split(/,\s*/).map((part) => {
    const p = cleanString(part).replace(/^"?|"?$/g, '');
    if (/^URI:/i.test(p)) return p.slice(4);
    if (/^(email|RFC822 Name):/i.test(p)) return p.replace(/^(email|RFC822 Name):/i, '');
    return p;
  }).map(normalizeIdentity).filter(Boolean));
}

function descriptorIdentities(row) {
  return collectStrings(
    row.identity,
    row.identities,
    row.subject,
    row.subjects,
    row.san,
    row.sans,
    row.subjectAltName,
    row.subject_alt_name,
  ).flatMap((value) => {
    const s = cleanString(value);
    if (!s) return [];
    if (/^(URI|email|RFC822 Name):/i.test(s) || /,\s*(URI|email|RFC822 Name):/i.test(s)) {
      return parseSubjectAltName(s);
    }
    return [normalizeIdentity(s)];
  }).filter(Boolean);
}

function descriptorIssuer(row) {
  return normalizeIssuer(
    row.oidc_issuer
    || row.oidcIssuer
    || row.fulcio_issuer
    || row.fulcioIssuer
    || row.issuer_uri
    || row.issuerUri
    || row.issuer,
  );
}

function describeCertificate(certish) {
  const x509 = tryX509(certish);
  if (x509) {
    return {
      basis: 'x509',
      x509,
      certificate_sha256: sha256Hex(x509.raw),
      subject: x509.subject,
      issuer: x509.issuer,
      oidc_issuer: null,
      identities: parseSubjectAltName(x509.subjectAltName),
      valid_from: x509.validFromDate ? x509.validFromDate.toISOString() : x509.validFrom,
      valid_to: x509.validToDate ? x509.validToDate.toISOString() : x509.validTo,
      ca: x509.ca,
      chain_verified: false,
    };
  }

  const row = certish && typeof certish === 'object' ? certish : {};
  const raw = rawBytesFromCertish(certish);
  const explicitSha = normalizeSha256Pin(
    row.sha256 || row.fingerprint256 || row.fingerprint_sha256 || row.certificate_sha256,
  );
  return {
    basis: 'descriptor',
    x509: null,
    certificate_sha256: explicitSha || (raw ? sha256Hex(raw) : fingerprintChainMaterial(row)),
    subject: cleanString(row.subject) || null,
    issuer: cleanString(row.issuer) || null,
    oidc_issuer: descriptorIssuer(row),
    identities: descriptorIdentities(row),
    valid_from: cleanString(row.valid_from || row.validFrom || row.not_before || row.notBefore) || null,
    valid_to: cleanString(row.valid_to || row.validTo || row.not_after || row.notAfter) || null,
    ca: row.ca === true,
    chain_verified: row.chain_verified === true || row.chainVerified === true,
  };
}

function chainFromVerificationMaterial(vm = {}) {
  const candidates = [
    vm.x509CertificateChain,
    vm.x509_certificate_chain,
    vm.certificateChain,
    vm.certificate_chain,
    vm.certificates,
    vm.chain,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (Array.isArray(candidate.certificates)) return candidate.certificates;
    if (Array.isArray(candidate.certs)) return candidate.certs;
  }
  return [];
}

function certificateFromBundle(bundle = {}) {
  const vm = bundle.verificationMaterial || bundle.verification_material || {};
  return vm.certificate
    || vm.x509Certificate
    || vm.x509_certificate
    || vm.cert
    || bundle.certificate
    || bundle.x509Certificate
    || bundle.x509_certificate
    || null;
}

function verifyX509Chain(descriptors) {
  const x509Rows = descriptors.filter((row) => row.basis === 'x509');
  if (x509Rows.length !== descriptors.length || x509Rows.length < 2) {
    return { ok: false, reason: 'x509_chain_incomplete' };
  }
  for (let i = 0; i < x509Rows.length - 1; i++) {
    const child = x509Rows[i].x509;
    const issuer = x509Rows[i + 1].x509;
    let issued = false;
    let sigOk = false;
    try { issued = child.checkIssued(issuer); } catch { issued = false; }
    try { sigOk = child.verify(issuer.publicKey); } catch { sigOk = false; }
    if (!issued || !sigOk) return { ok: false, reason: `x509_chain_link_${i}_failed` };
  }
  const root = x509Rows[x509Rows.length - 1].x509;
  let rootSelfSigned = false;
  try { rootSelfSigned = root.verify(root.publicKey); } catch { rootSelfSigned = false; }
  if (!rootSelfSigned) return { ok: false, reason: 'x509_root_not_self_signed' };
  if (root.ca !== true) return { ok: false, reason: 'x509_root_not_ca' };
  return { ok: true, reason: 'x509_chain_verified' };
}

function collectRootPins(bundle, descriptors) {
  const vm = bundle.verificationMaterial || bundle.verification_material || {};
  const chain = vm.x509CertificateChain || vm.x509_certificate_chain || vm.certificateChain || vm.certificate_chain || {};
  const roots = [];
  const last = descriptors[descriptors.length - 1];
  if (last?.certificate_sha256) roots.push(last.certificate_sha256);
  roots.push(
    vm.fulcio_root_sha256,
    vm.fulcioRootSha256,
    vm.root_sha256,
    vm.rootFingerprintSha256,
    chain.root_sha256,
    chain.rootFingerprintSha256,
    bundle.fulcio_root_sha256,
    bundle.root_sha256,
    bundle.fulcio?.root_sha256,
  );
  return unique(roots.map(normalizeSha256Pin).filter(Boolean));
}

function collectTlogEntries(bundle = {}) {
  const vm = bundle.verificationMaterial || bundle.verification_material || {};
  return [
    ...asArray(vm.tlogEntries),
    ...asArray(vm.tlog_entries),
    ...asArray(vm.transparencyLogEntries),
    ...asArray(vm.transparency_log_entries),
    ...asArray(bundle.tlogEntries),
    ...asArray(bundle.tlog_entries),
  ].filter((entry) => entry && typeof entry === 'object');
}

function logIdFromTlogEntry(entry = {}) {
  const raw = entry.logId?.keyId
    || entry.logId?.key_id
    || entry.log_id?.key_id
    || entry.log_id?.keyId
    || entry.logID
    || (typeof entry.logId === 'string' ? entry.logId : null)
    || (typeof entry.log_id === 'string' ? entry.log_id : null);
  return cleanString(raw).toLowerCase();
}

function hasInclusionProof(entry = {}) {
  return !!(
    entry.inclusionProof
    || entry.inclusion_proof
    || entry.verification?.inclusionProof
    || entry.verification?.inclusion_proof
    || entry.inclusionPromise
    || entry.inclusion_promise
  );
}

function integratedTimeFromEntries(entries) {
  for (const entry of entries) {
    const value = entry.integratedTime ?? entry.integrated_time ?? entry.inclusionPromise?.signedEntryTimestamp;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n * 1000;
  }
  return null;
}

export function extractSigstoreKeylessMaterial(bundle = {}) {
  const vm = bundle.verificationMaterial || bundle.verification_material || {};
  const leaf = certificateFromBundle(bundle);
  const chainRows = chainFromVerificationMaterial(vm);
  const certRows = [leaf, ...chainRows].filter(Boolean);
  const descriptors = certRows.map(describeCertificate);
  const certificate = descriptors[0] || null;
  const chainCheck = verifyX509Chain(descriptors);
  const tlogEntries = collectTlogEntries(bundle);
  const rootSha256 = collectRootPins(bundle, descriptors);
  const rekorLogIds = unique(tlogEntries.map(logIdFromTlogEntry).filter(Boolean));
  const hasProof = tlogEntries.some(hasInclusionProof);

  return {
    version: SIGSTORE_KEYLESS_POLICY_VERSION,
    present: !!certificate,
    certificate,
    certificate_chain: descriptors,
    certificate_chain_basis: certificate?.basis || null,
    x509_chain_verified: chainCheck.ok,
    x509_chain_reason: chainCheck.reason,
    identities: certificate ? unique(certificate.identities || []) : [],
    oidc_issuer: certificate?.oidc_issuer || null,
    certificate_issuer: certificate?.issuer || null,
    fulcio_root_sha256: rootSha256,
    tlog_entry_count: tlogEntries.length,
    rekor_log_ids: rekorLogIds,
    rekor_inclusion_present: hasProof,
    integrated_time_ms: integratedTimeFromEntries(tlogEntries),
    source_repository: cleanString(certificate?.source_repository || vm.source_repository || bundle.source_repository) || null,
    workflow_ref: cleanString(certificate?.workflow_ref || vm.workflow_ref || bundle.workflow_ref) || null,
    workflow_sha: cleanString(certificate?.workflow_sha || vm.workflow_sha || bundle.workflow_sha) || null,
  };
}

function timeWithinCertificate(material) {
  const cert = material.certificate;
  if (!cert || (!cert.valid_from && !cert.valid_to)) return { ok: true, reason: 'no_validity_window' };
  const at = material.integrated_time_ms || Date.now();
  const from = cert.valid_from ? Date.parse(cert.valid_from) : null;
  const to = cert.valid_to ? Date.parse(cert.valid_to) : null;
  if (Number.isFinite(from) && at < from) return { ok: false, reason: 'certificate_not_yet_valid_at_log_time' };
  if (Number.isFinite(to) && at > to) return { ok: false, reason: 'certificate_expired_at_log_time' };
  return { ok: true, reason: 'certificate_valid_at_log_time' };
}

export function verifySigstoreKeylessBundle(bundle, policyInput = {}) {
  const policy = policyInput.version === SIGSTORE_KEYLESS_POLICY_VERSION
    ? policyInput
    : buildFulcioKeylessPolicy(policyInput);
  const material = extractSigstoreKeylessMaterial(bundle || {});
  const failures = [...(policy.failures || [])];

  if (!material.present) failures.push('keyless_certificate_missing');

  const issuer = normalizeIssuer(material.oidc_issuer);
  if (material.present && (!issuer || !policy.issuers.includes(issuer))) {
    failures.push('oidc_issuer_not_allowed');
  }

  const materialIdentities = material.identities.map(normalizeIdentity).filter(Boolean);
  const identityMatch = materialIdentities.some((identity) => policy.identities.includes(identity));
  if (material.present && !identityMatch) failures.push('oidc_identity_not_allowed');

  const rootMatch = material.fulcio_root_sha256.some((pin) => policy.fulcio_root_sha256.includes(pin));
  if (material.present && !rootMatch) failures.push('fulcio_root_pin_mismatch');

  let chainOk = material.x509_chain_verified;
  let descriptorFixture = false;
  if (!chainOk && material.certificate_chain_basis === 'descriptor' && policy.allow_descriptor_fixture) {
    descriptorFixture = true;
    chainOk = true;
  }
  if (policy.require_certificate_chain && material.present && !chainOk) {
    failures.push(material.x509_chain_reason || 'certificate_chain_not_verified');
  }

  if (policy.require_rekor) {
    if (material.tlog_entry_count === 0) failures.push('rekor_entry_missing');
    if (policy.rekor_log_ids.length > 0) {
      const logMatch = material.rekor_log_ids.some((id) => policy.rekor_log_ids.includes(id));
      if (!logMatch) failures.push('rekor_log_id_not_allowed');
    }
    if (policy.require_rekor_inclusion && !material.rekor_inclusion_present) {
      failures.push('rekor_inclusion_missing');
    }
  }

  const timeCheck = timeWithinCertificate(material);
  if (!timeCheck.ok) failures.push(timeCheck.reason);

  if (policy.source_repository && material.source_repository !== policy.source_repository) {
    failures.push('source_repository_mismatch');
  }
  if (policy.workflow_ref && material.workflow_ref !== policy.workflow_ref) {
    failures.push('workflow_ref_mismatch');
  }
  if (policy.workflow_sha && material.workflow_sha !== policy.workflow_sha) {
    failures.push('workflow_sha_mismatch');
  }

  const ok = failures.length === 0;
  return {
    ok,
    version: SIGSTORE_KEYLESS_POLICY_VERSION,
    claim_scope: descriptorFixture ? SIGSTORE_KEYLESS_DESCRIPTOR_FIXTURE_SCOPE : SIGSTORE_KEYLESS_CLAIM_SCOPE,
    keyless_oidc_identity_bound: ok,
    certificate_identity_bound: ok && identityMatch,
    certificate_chain_verified: chainOk,
    certificate_chain_basis: material.certificate_chain_basis,
    descriptor_fixture: descriptorFixture,
    fulcio_root_pinned: ok && rootMatch,
    rekor_bound: policy.require_rekor ? ok : material.tlog_entry_count > 0,
    slsa_build_l3_claim_allowed: false,
    hardened_builder_required_for_l3: true,
    failures,
    material: {
      identities: material.identities,
      oidc_issuer: material.oidc_issuer,
      certificate_issuer: material.certificate_issuer,
      fulcio_root_sha256: material.fulcio_root_sha256,
      tlog_entry_count: material.tlog_entry_count,
      rekor_log_ids: material.rekor_log_ids,
      rekor_inclusion_present: material.rekor_inclusion_present,
      source_repository: material.source_repository,
      workflow_ref: material.workflow_ref,
      workflow_sha: material.workflow_sha,
    },
    policy: {
      issuers: policy.issuers,
      identities: policy.identities,
      fulcio_root_sha256: policy.fulcio_root_sha256,
      rekor_log_ids: policy.rekor_log_ids,
      require_rekor: policy.require_rekor,
      require_certificate_chain: policy.require_certificate_chain,
    },
  };
}

export function assessSlsaL3Eligibility({ keylessVerification, hardenedBuilderEvidence } = {}) {
  const failures = [];
  if (!keylessVerification || keylessVerification.ok !== true) failures.push('keyless_identity_not_verified');
  const evidence = hardenedBuilderEvidence || {};
  if (evidence.hardened_builder !== true && evidence.hardenedBuilder !== true) failures.push('hardened_builder_missing');
  if (evidence.ephemeral_isolated_builder !== true && evidence.ephemeralIsolatedBuilder !== true) failures.push('ephemeral_isolated_builder_missing');
  if (evidence.non_falsifiable_provenance !== true && evidence.nonFalsifiableProvenance !== true) failures.push('non_falsifiable_provenance_missing');
  if (evidence.builder_id == null && evidence.builderId == null) failures.push('builder_id_missing');
  return {
    ok: failures.length === 0,
    version: SIGSTORE_KEYLESS_POLICY_VERSION,
    slsa_build_l3_claim_allowed: failures.length === 0,
    failures,
    keyless_claim_scope: keylessVerification?.claim_scope || null,
  };
}

export default {
  SIGSTORE_KEYLESS_POLICY_VERSION,
  SIGSTORE_KEYLESS_CLAIM_SCOPE,
  SIGSTORE_KEYLESS_DESCRIPTOR_FIXTURE_SCOPE,
  FULCIO_OIDC_ISSUER_OID,
  buildFulcioKeylessPolicy,
  extractSigstoreKeylessMaterial,
  verifySigstoreKeylessBundle,
  assessSlsaL3Eligibility,
  fingerprintChainMaterial,
  normalizeSha256Pin,
};
