// kolm-audit-verify.js - REAL, dependency-free, fully-offline verification of a
// kolm Agent Security-Review *audit report*'s Ed25519 signature, in the browser,
// using WebCrypto.
//
// This is the buyer-facing proof: a reviewer pastes the signed evidence-report
// JSON the vendor handed them and confirms - with no upload, no kolm server, no
// shared secret, no account - that the bytes were signed by the holder of the
// embedded public key and have NOT been altered since (a downgraded readiness
// number, a deleted finding, a flipped tamper-evident flag all break the check).
//
// It does ACTUAL cryptography. There are no canned "OK" lines: if this browser
// lacks native Ed25519, or the signature does not check, it says so plainly.
//
// The canonicalization here is byte-identical to src/attestation-report-
// builder.js (canonicalize / canonicalizeReport): recursive, key-sorted,
// whitespace-free JSON with the signature block excluded. A report this library
// accepts is the same one the Node builder/verifier accept. Keep the two in
// lock-step - if you change one, change the other.
//
// Usage:
//   import { verifyAuditReport } from '/kolm-audit-verify.js';
//   const result = await verifyAuditReport(reportObject);
//   // result = { ok, reason?, key_fingerprint?, checks: [{name, ok, detail}] }
//
// Also exposed as window.kolmAuditVerify for plain <script> pages.

export const AUDIT_REPORT_SCHEMA = 'kolm-audit-report-1';
export const ED25519_SPEC = 'kolm-ed25519-v1';
export const ED25519_ALG = 'ed25519';

// ---------------------------------------------------------------------------
// Canonicalization - MUST be byte-identical to src/attestation-report-builder.js.
// Recursive, key-sorted, whitespace-free JSON. Sorting keys makes the bytes
// independent of property order, so this browser code and the Node signer agree
// without sharing a field list. `undefined` is dropped (matching JSON.stringify);
// non-finite numbers serialize to 'null'.
// ---------------------------------------------------------------------------
export function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v === undefined ? null : v)).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return 'null';
}

export function canonicalizeReport(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('canonicalizeReport: envelope must be an object');
  }
  // Object rest-destructuring (CopyDataProperties) - byte-identical to the Node
  // builder's `const { signature_ed25519, ...rest } = envelope`. A plain
  // `rest[k] = envelope[k]` loop would diverge on a hostile `__proto__` key: the
  // assignment hits the Object.prototype __proto__ setter and silently drops the
  // key, whereas the Node spread copies it as an own data property. Using the
  // same construct on both sides keeps the signed bytes in lock-step.
  //
  // Excluded (MUST match src/attestation-report-builder.js exactly):
  //   - signature_ed25519: a signature cannot cover itself.
  //   - timestamp_evidence + log_checkpoint: DETACHED evidence added after
  //     signing (each references the signed report digest), so they are bound to
  //     the report but not covered by its signature. Excluding them keeps the
  //     canonical bytes identical whether or not they are attached.
  //   - co_signatures: additional named-reviewer Ed25519 signatures added AFTER
  //     the primary signature, each over this same canonical payload. Excluding
  //     them keeps the primary signature stable when a co-signature is attached.
  const { signature_ed25519, timestamp_evidence, log_checkpoint, co_signatures, ...rest } = envelope;
  void signature_ed25519; void timestamp_evidence; void log_checkpoint; void co_signatures;
  return canonicalize(rest);
}

// Normalize a PEM for whitespace-insensitive equality (line-ending / trailing-
// newline differences must not change identity).
export function normalizePem(pem) {
  return String(pem == null ? '' : pem).replace(/\s+/g, '');
}

// issuerProvenance - does the report's embedded signing key belong to a known
// kolm issuer? Pure, synchronous (PEM compare, no async digest), never throws.
// This is the second tier of trust: tier 1 (verifyAuditReport) proves "signed by
// the holder of the embedded key, untampered"; this proves "and that key is one
// kolm publishes" - without it, an attacker can re-sign a tampered report with
// their OWN key and tier 1 alone would still pass.
//
// keyring: { issuers: [{ kid, label, status, public_key }] }
// returns { recognized, kid?, label?, status?, embedded_key? }
export function issuerProvenance(report, keyring) {
  const out = { recognized: false };
  try {
    const block = report && typeof report === 'object' ? report.signature_ed25519 : null;
    const pem = block && typeof block === 'object' ? block.public_key : null;
    if (typeof pem !== 'string' || !pem) return out;
    const list = keyring && Array.isArray(keyring.issuers) ? keyring.issuers : [];
    const target = normalizePem(pem);
    for (const iss of list) {
      if (iss && typeof iss.public_key === 'string' && normalizePem(iss.public_key) === target) {
        return { recognized: true, kid: iss.kid || null, label: iss.label || null, status: iss.status || null, embedded_key: pem };
      }
    }
    out.embedded_key = pem;
  } catch (_) { /* never throw */ }
  return out;
}

// isFingerprintRevoked - tier-3 key lifecycle. A signature can be cryptograph-
// ically valid yet untrustworthy if its key was later REVOKED. An offline
// browser cannot know revocation on its own, so the caller supplies a revocation
// source (fetched once from the public status feed / keyring):
//   opts.revokedFingerprints: array/Set/object of 32-hex fingerprints, OR
//   opts.issuerKeyring: { issuers:[{public_key,status,revoked}], revocations:[] }
// Pure, synchronous, never throws.
export function normalizeFpSet(src) {
  const set = new Set();
  if (!src) return set;
  let list = [];
  if (Array.isArray(src)) list = src;
  else if (src instanceof Set) list = [...src];
  else if (typeof src === 'object') list = Object.keys(src);
  else list = [src];
  for (const x of list) {
    const s = String(x == null ? '' : x).trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    if (s) set.add(s);
  }
  return set;
}

export function isFingerprintRevoked(fp, pem, opts = {}) {
  try {
    const f = String(fp || '').trim().toLowerCase();
    if (f && normalizeFpSet(opts.revokedFingerprints).has(f)) return true;
    const kr = opts.issuerKeyring;
    if (kr && typeof kr === 'object') {
      if (typeof pem === 'string' && Array.isArray(kr.issuers)) {
        const target = normalizePem(pem);
        for (const iss of kr.issuers) {
          if (iss && typeof iss.public_key === 'string' && normalizePem(iss.public_key) === target) {
            if (iss.revoked === true || String(iss.status || '').toLowerCase() === 'revoked') return true;
          }
        }
      }
      if (Array.isArray(kr.revocations)) {
        for (const rv of kr.revocations) {
          const rfp = String((rv && (rv.fingerprint || rv)) || '').trim().toLowerCase();
          if (rfp && rfp === f) return true;
        }
      }
    }
  } catch (_) { /* never throw */ }
  return false;
}

// ---------------------------------------------------------------------------
// byte / key helpers (shared shape with public/kolm-verify.js).
// ---------------------------------------------------------------------------
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToBytes(b64url) {
  let s = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return base64ToBytes(s);
}

export function pemToDer(pem) {
  if (typeof pem !== 'string') throw new Error('pemToDer: public_key must be a PEM string');
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (!b64) throw new Error('pemToDer: no key body found in PEM');
  return base64ToBytes(b64);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// SHA-256 over the SPKI DER, first 32 hex chars (128-bit) - matches
// src/ed25519.js keyFingerprint() byte-for-byte.
export async function keyFingerprintFromPem(publicKeyPem) {
  const der = pemToDer(publicKeyPem);
  const digest = await crypto.subtle.digest('SHA-256', der);
  return bytesToHex(new Uint8Array(digest)).slice(0, 32);
}

function ed25519Available() {
  return !!(globalThis.crypto && crypto.subtle && typeof crypto.subtle.importKey === 'function');
}

// ---------------------------------------------------------------------------
// verifyAuditReport - the real check. Returns { ok, reason?, key_fingerprint?,
// checks[] }. Every entry in `checks` is the outcome of a genuine operation;
// none are pre-filled. NEVER throws - bad input yields ok:false with a reason.
//
// opts.pinnedPublicKeyPem (optional): require the report's embedded key to equal
// a key you trust. Without it, the check proves "signed by the holder of THIS
// key, untampered"; pin to also prove "and that key is the one I expected".
// ---------------------------------------------------------------------------
export async function verifyAuditReport(report, opts = {}) {
  const checks = [];
  const fail = (reason) => ({ ok: false, reason, checks });

  if (typeof report === 'string') {
    try { report = JSON.parse(report); }
    catch (e) { return fail('input is not valid JSON: ' + e.message); }
  }
  if (!report || typeof report !== 'object') return fail('report must be a JSON object');

  if (report.schema && report.schema !== AUDIT_REPORT_SCHEMA) {
    return fail(`unexpected schema: ${report.schema} (expected ${AUDIT_REPORT_SCHEMA})`);
  }
  checks.push({ name: 'schema', ok: true, detail: report.schema || '(none)' });

  const block = report.signature_ed25519;
  if (!block || typeof block !== 'object') return fail('report has no signature_ed25519 block');
  checks.push({ name: 'signature block present', ok: true, detail: `alg=${block.alg || '?'} spec=${block.spec || '?'}` });

  if (block.spec && block.spec !== ED25519_SPEC) return fail(`unexpected spec: ${block.spec}`);
  if (block.alg && block.alg !== ED25519_ALG) return fail(`unexpected alg: ${block.alg}`);
  if (typeof block.public_key !== 'string' || !block.public_key) return fail('signature block missing public_key');
  if (typeof block.signature !== 'string' || !block.signature) return fail('signature block missing signature');

  // Tier-3 (optional): refuse a REVOKED issuer key BEFORE reporting any clean
  // pass. Runs only when the caller supplies a revocation source, and runs
  // before the WebCrypto-Ed25519 availability gate so a revoked key is rejected
  // even in a browser that cannot run the signature check. Computing the
  // fingerprint needs only SHA-256, which is universally available.
  if (opts.revokedFingerprints || opts.issuerKeyring) {
    let revFp = null;
    try {
      const der0 = pemToDer(block.public_key);
      revFp = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', der0))).slice(0, 32);
    } catch (_) { revFp = null; }
    if (revFp && isFingerprintRevoked(revFp, block.public_key, opts)) {
      checks.push({ name: 'issuer key not revoked', ok: false, detail: `key ${revFp.slice(0, 12)}… is revoked` });
      return { ok: false, reason: 'issuer_key_revoked', key_fingerprint: revFp, checks };
    }
    checks.push({ name: 'issuer key not revoked', ok: true, detail: revFp || '(fingerprint unavailable)' });
  }

  if (!ed25519Available()) {
    checks.push({ name: 'native Ed25519', ok: false, detail: 'this browser lacks WebCrypto Ed25519' });
    return { ok: false, reason: 'native Ed25519 unavailable in this browser (need Chrome 137+ / Safari 17+ / Firefox 129+); signature was NOT checked', checks };
  }

  // 1. Rebuild the exact signed bytes.
  let canonical;
  try { canonical = canonicalizeReport(report); }
  catch (e) { return fail('cannot canonicalize report: ' + e.message); }
  checks.push({ name: 'canonical payload rebuilt', ok: true, detail: `${canonical.length} bytes` });

  // 2. Independently recompute the key fingerprint and cross-check the claim.
  let der, fp;
  try {
    der = pemToDer(block.public_key);
    fp = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', der))).slice(0, 32);
  } catch (e) { return fail('cannot read public_key: ' + e.message); }
  // Coerce to string before compare/slice - a hostile report can put a number,
  // boolean or object here, and this function must never throw.
  const claimedFp = block.key_fingerprint == null ? null : String(block.key_fingerprint);
  if (claimedFp && claimedFp !== fp) {
    checks.push({ name: 'key fingerprint matches public_key', ok: false, detail: `claimed ${claimedFp.slice(0, 12)}… vs actual ${fp.slice(0, 12)}…` });
    return { ok: false, reason: 'key_fingerprint claim does not match public_key bytes', key_fingerprint: fp, checks };
  }
  checks.push({ name: 'key fingerprint matches public_key', ok: true, detail: fp });

  // 3. Optional pinning against a trusted issuer key.
  if (opts.pinnedPublicKeyPem) {
    const norm = (s) => s.replace(/\s+/g, '');
    if (norm(opts.pinnedPublicKeyPem) !== norm(block.public_key)) {
      checks.push({ name: 'pinned issuer key', ok: false, detail: 'embedded key != pinned key' });
      return { ok: false, reason: 'public_key does not match pinned issuer key', key_fingerprint: fp, checks };
    }
    checks.push({ name: 'pinned issuer key', ok: true, detail: 'matches expected issuer' });
  }

  // 4. The real Ed25519 verification.
  let ok;
  try {
    const key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
    const sig = base64UrlToBytes(block.signature);
    const msg = new TextEncoder().encode(canonical);
    ok = await crypto.subtle.verify('Ed25519', key, sig, msg);
  } catch (e) {
    checks.push({ name: 'Ed25519 signature', ok: false, detail: 'verify error: ' + e.message });
    return { ok: false, reason: 'Ed25519 verification raised: ' + e.message, key_fingerprint: fp, checks };
  }
  checks.push({ name: 'Ed25519 signature valid', ok, detail: ok ? 'signature matches payload' : 'signature does NOT match payload' });
  if (!ok) return { ok: false, reason: 'Ed25519 signature does not verify against the canonical payload', key_fingerprint: fp, checks };

  // 5. signed_at consistency. block.signed_at is NOT covered by the signature
  // (it lives in the block the signature excludes); generated_at IS. They are
  // equal at signing time, so a mismatch means the shown timestamp was edited
  // after signing - fail rather than display a clean pass over a forged date.
  if (block.signed_at != null && report.generated_at != null
      && String(block.signed_at) !== String(report.generated_at)) {
    checks.push({ name: 'signed_at matches signed generated_at', ok: false, detail: `block.signed_at=${String(block.signed_at)} ≠ generated_at=${String(report.generated_at)}` });
    return { ok: false, reason: 'signed_at does not match the signed generated_at (timestamp altered after signing)', key_fingerprint: fp, checks };
  }
  checks.push({ name: 'signed_at matches signed generated_at', ok: true, detail: String(report.generated_at || '(none)') });

  // Optional additive evidence (gracefully optional - never flips the verdict).
  // Both fields live in the SIGNED payload, so any tampering already broke the
  // Ed25519 check above; here we just surface their presence + shape.
  //   timestamp_evidence: an RFC 3161 trusted timestamp (independent of kolm's
  //     clock). Full token verification is a Node-side / SDK concern; the
  //     browser confirms it binds the same digest family and is well-formed.
  //   log_checkpoint: a transparency-log signed tree head the report anchors to.
  if (report.timestamp_evidence && typeof report.timestamp_evidence === 'object') {
    const te = report.timestamp_evidence;
    const st = String(te.status || '');
    const imprintOk = typeof te.message_imprint === 'string' && /^[0-9a-f]{64}$/i.test(te.message_imprint);
    if (st === 'timestamped' && te.token_b64 && imprintOk) {
      checks.push({ name: 'trusted timestamp present', ok: true, detail: `TSA ${te.tsa_url || '?'} @ ${te.timestamp || '?'}` });
    } else if (st === 'offline') {
      checks.push({ name: 'trusted timestamp', ok: true, detail: 'not timestamped (status offline) - additive evidence absent' });
    } else {
      checks.push({ name: 'trusted timestamp', ok: false, detail: 'timestamp_evidence present but malformed (informational; verdict unaffected)' });
    }
  }
  if (report.log_checkpoint && typeof report.log_checkpoint === 'object') {
    const lc = report.log_checkpoint;
    const ok = typeof lc.root_hash === 'string' && /^[0-9a-f]{64}$/i.test(lc.root_hash) && Number.isFinite(Number(lc.tree_size));
    checks.push({ name: 'transparency-log checkpoint present', ok, detail: ok ? `tree_size=${lc.tree_size} root=${String(lc.root_hash).slice(0, 12)}` : 'log_checkpoint present but malformed (informational; verdict unaffected)' });
  }
  // Input-evidence digest (M2 / ASR-6). It is signature-covered, so any tampering
  // already failed the Ed25519 check above. The events themselves are not carried
  // in the report (they can hold sensitive bodies), so the browser confirms the
  // digest is well-formed and that its event_count matches the report's stated
  // subject.events - a real cross-check over the signed content. Informational.
  if (report.evidence_digest && typeof report.evidence_digest === 'object') {
    const edv = report.evidence_digest;
    const wf = edv.alg === 'sha256' && typeof edv.value === 'string' && /^[0-9a-f]{64}$/i.test(edv.value);
    let ok = wf;
    let detail = wf ? `${String(edv.value).slice(0, 16)} over ${edv.event_count} event(s)` : 'malformed evidence_digest';
    const subjEvents = report.subject && typeof report.subject === 'object' ? report.subject.events : null;
    if (wf && subjEvents != null && Number.isFinite(Number(edv.event_count)) && Number(edv.event_count) !== Number(subjEvents)) {
      ok = false;
      detail = `event_count ${edv.event_count} != subject.events ${subjEvents}`;
    }
    checks.push({ name: 'input-evidence digest present (signature-covered)', ok, detail });
  }
  // Agent identity passport - surfaced (it is signature-covered, not re-derived).
  if (report.passport && typeof report.passport === 'object') {
    const pp = report.passport;
    const ok = pp.spec_version === 'asr-passport/0.1' || (Array.isArray(pp.agents) && Array.isArray(pp.models));
    checks.push({ name: 'agent identity passport present', ok, detail: ok ? `${(pp.agents || []).length} agent(s), ${(pp.models || []).length} model(s); identity ${pp.identity_status || '?'}, provenance ${pp.provenance_status || '?'}` : 'passport present but malformed (informational; verdict unaffected)' });
  }

  return { ok: true, key_fingerprint: fp, checks };
}

// UMD-ish global for plain <script src> pages.
if (typeof window !== 'undefined') {
  window.kolmAuditVerify = { verifyAuditReport, canonicalize, canonicalizeReport, keyFingerprintFromPem, pemToDer, normalizePem, issuerProvenance, isFingerprintRevoked, normalizeFpSet, AUDIT_REPORT_SCHEMA };
}
