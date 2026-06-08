// src/rfc3161-timestamp.js
//
// TRACK CRYPTO-SERVICES / M3 - RFC 3161 trusted timestamping.
//
// WHY THIS EXISTS
//   An Ed25519 signature proves "the holder of this key signed these exact
//   bytes". It does NOT prove WHEN. A vendor could backdate generated_at,
//   re-sign, and the signature still verifies. A trusted timestamp closes that
//   gap: an INDEPENDENT third party (a public RFC 3161 Time-Stamping Authority)
//   countersigns a hash of our report at a point in time, so a buyer can prove
//   the evidence existed no later than that instant WITHOUT trusting kolm's
//   clock.
//
// WHAT IT PRODUCES (the contract the later report-embedding wave consumes):
//   timestamp_evidence = {
//     alg: 'sha256',
//     message_imprint: <64-hex sha256 of the thing being timestamped>,
//     timestamp: <ISO 8601 genTime from the TSA token | null>,
//     token_b64: <base64 DER of the RFC 3161 TimeStampToken | null>,
//     tsa_url: <the TSA endpoint>,
//     status: 'timestamped' | 'offline',
//     ...diagnostics (reason, serial, policy, source)
//   }
//   status:'offline' is the graceful-degrade outcome: the network was down, the
//   TSA refused, or the response did not parse. timestampDigest NEVER throws -
//   timestamping is additive evidence, never a hard dependency of the report.
//
// HOW IT VERIFIES (verifyTimestamp)
//   Fully OFFLINE, no trust store required. It re-derives every claim from the
//   token bytes:
//     1) the TSA token's messageImprint EQUALS the digest we are checking,
//     2) the token's genTime EQUALS the recorded evidence.timestamp,
//     3) (enhancement) the CMS SignedData signature over the TSTInfo verifies
//        against the signer certificate embedded in the token.
//   (1)+(2) bind the timestamp to our content. (3) proves the token has not been
//   altered since the TSA emitted it. We are explicit that (3) checks the token
//   against its EMBEDDED cert (internal consistency / tamper-evidence), not
//   against a pinned trust root - chaining to a CA root is a deployment policy
//   choice, surfaced as `trust:'embedded-cert'` so nobody over-reads the claim.
//
// SELF-ISSUED FALLBACK (selfIssueTimestamp)
//   An OPTIONAL, opt-in internal authority: when no external TSA is reachable a
//   caller may self-issue a real RFC 3161 TimeStampToken signed by a kolm key.
//   It is weaker than an independent TSA (kolm is asserting its own clock) and
//   is clearly marked source:'self', but it is a genuine, parseable, verifiable
//   token - and it lets the verifier round-trip be exercised fully offline.
//
// DEPENDENCIES: node:crypto ONLY. The ASN.1/DER encode+decode and the CMS walk
// are hand-rolled here (small, auditable, dependency-free) so this module is a
// leaf in the import graph and ports cleanly to an SDK.

import crypto from 'node:crypto';

export const RFC3161_VERSION = 'kolm-rfc3161-v1';
export const TIMESTAMP_ALG = 'sha256';

// A public, no-account RFC 3161 TSA. FreeTSA is the documented default; override
// with KOLM_TSA_URL (e.g. http://timestamp.sectigo.com or http://timestamp.digicert.com).
export const DEFAULT_TSA_URL = 'https://freetsa.org/tsr';

// Object identifiers used by RFC 3161 / RFC 5652 (CMS).
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SHA512 = '2.16.840.1.101.3.4.2.3';
const OID_SHA384 = '2.16.840.1.101.3.4.2.2';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TSTINFO = '1.2.840.113549.1.9.16.1.4';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_SHA384_RSA = '1.2.840.113549.1.1.12';
const OID_SHA512_RSA = '1.2.840.113549.1.1.13';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_ECDSA_SHA384 = '1.2.840.10045.4.3.3';
const OID_ED25519 = '1.3.101.112';
const OID_COMMON_NAME = '2.5.4.3';
// A kolm-private policy arc for self-issued tokens (distinct from any TSA).
const OID_KOLM_SELF_POLICY = '1.3.6.1.4.1.57264.7.1';

// ===========================================================================
// Minimal DER encoder. Every helper returns a Buffer of a complete TLV.
// ===========================================================================
function derLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  const out = [];
  let n = len;
  while (n > 0) { out.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | out.length, ...out]);
}
function tlv(tag, content) {
  const c = Buffer.isBuffer(content) ? content : Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLen(c.length), c]);
}
function derSeq(...items) { return tlv(0x30, Buffer.concat(items)); }
function derSet(...items) { return tlv(0x31, Buffer.concat(items)); }
function derInt(value) {
  let bytes;
  if (Buffer.isBuffer(value)) {
    bytes = value.length ? value : Buffer.from([0]);
  } else {
    const n = Math.trunc(Number(value) || 0);
    if (n === 0) bytes = Buffer.from([0]);
    else {
      const arr = [];
      let x = n;
      while (x > 0) { arr.unshift(x & 0xff); x = Math.floor(x / 256); }
      bytes = Buffer.from(arr);
    }
  }
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]); // keep positive
  return tlv(0x02, bytes);
}
function derOid(oid) {
  const parts = String(oid).split('.').map((x) => parseInt(x, 10));
  if (parts.length < 2 || parts.some((x) => !Number.isFinite(x))) throw new Error('bad oid: ' + oid);
  const body = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    body.push(...stack);
  }
  return tlv(0x06, Buffer.from(body));
}
function derOctet(buf) { return tlv(0x04, buf); }
function derNull() { return Buffer.from([0x05, 0x00]); }
function derBool(b) { return Buffer.from([0x01, 0x01, b ? 0xff : 0x00]); }
function derUtf8(str) { return tlv(0x0c, Buffer.from(String(str), 'utf8')); }
function derBitString(buf) { return tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf])); }
function ctxExplicit(num, content) { return tlv(0xa0 | num, content); } // [num] constructed
function gtString(date) {
  const z = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getUTCFullYear()}${z(date.getUTCMonth() + 1)}${z(date.getUTCDate())}`
    + `${z(date.getUTCHours())}${z(date.getUTCMinutes())}${z(date.getUTCSeconds())}Z`;
}
function derGeneralizedTime(date) {
  return tlv(0x18, Buffer.from(gtString(date), 'ascii'));
}
function algId(oid, withNull = true) {
  return withNull ? derSeq(derOid(oid), derNull()) : derSeq(derOid(oid));
}

// ===========================================================================
// Minimal DER parser. Returns a node tree of TLVs; `raw` is the complete TLV
// bytes (header + content) so any sub-structure can be re-extracted verbatim.
// ===========================================================================
function parseTLV(buf, offset = 0) {
  if (offset + 2 > buf.length) throw new Error('der: truncated header');
  const tag = buf[offset];
  let pos = offset + 1;
  let len = buf[pos++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('der: unsupported length form');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[pos++];
  }
  const contentStart = pos;
  const contentEnd = pos + len;
  if (contentEnd > buf.length) throw new Error('der: length exceeds buffer');
  return {
    tag,
    len,
    start: offset,
    contentStart,
    contentEnd,
    totalEnd: contentEnd,
    content: buf.slice(contentStart, contentEnd),
    raw: buf.slice(offset, contentEnd),
  };
}
function parseChildren(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const t = parseTLV(buf, pos);
    out.push(t);
    pos = t.totalEnd;
  }
  return out;
}
function oidToStr(content) {
  const b = content;
  if (!b.length) return '';
  const first = b[0];
  const parts = [Math.floor(first / 40), first % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = (v * 128) + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join('.');
}
function genTimeToIso(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z?$/.exec(String(s).trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ''}Z`;
}

// ===========================================================================
// TimeStampReq builder (RFC 3161 section 2.4.1).
// ===========================================================================
export function buildTimeStampReq(sha256hex, opts = {}) {
  const digest = Buffer.from(String(sha256hex), 'hex');
  if (digest.length !== 32) throw new Error('buildTimeStampReq: sha256hex must be 32 bytes hex');
  const messageImprint = derSeq(algId(OID_SHA256), derOctet(digest));
  const items = [derInt(1), messageImprint];
  if (opts.reqPolicy) items.push(derOid(opts.reqPolicy));
  if (opts.nonce && Buffer.isBuffer(opts.nonce) && opts.nonce.length) items.push(derInt(opts.nonce));
  // certReq TRUE so the response carries the TSA certificate -> the token is
  // self-contained and verifyTimestamp can check the CMS signature offline.
  items.push(derBool(opts.certReq !== false));
  return derSeq(...items);
}

// ===========================================================================
// Parse a TimeStampResp -> the embedded TimeStampToken (a CMS ContentInfo DER).
// ===========================================================================
function parseTimeStampResp(buf) {
  const outer = parseTLV(buf, 0);
  if (outer.tag !== 0x30) return { ok: false, reason: 'resp_not_sequence' };
  const kids = parseChildren(outer.content);
  if (!kids.length) return { ok: false, reason: 'resp_empty' };
  const statusKids = parseChildren(kids[0].content);
  const statusVal = statusKids.length && statusKids[0].tag === 0x02 ? bufToInt(statusKids[0].content) : -1;
  // 0 = granted, 1 = grantedWithMods; anything else is a rejection.
  if (statusVal !== 0 && statusVal !== 1) return { ok: false, reason: `tsa_status_${statusVal}` };
  if (kids.length < 2) return { ok: false, reason: 'resp_no_token' };
  return { ok: true, tokenDer: kids[1].raw };
}
function bufToInt(b) {
  let n = 0;
  for (const byte of b) n = (n * 256) + byte;
  return n;
}

// ===========================================================================
// Walk a TimeStampToken (CMS ContentInfo) down to its TSTInfo + key fields.
// Returns null on any structural problem (caller maps to a graceful outcome).
// ===========================================================================
function extractTstInfoBytes(tokenDer) {
  const ci = parseTLV(tokenDer, 0);
  const ciKids = parseChildren(ci.content);
  const explicit = ciKids.find((k) => k.tag === 0xa0);
  if (!explicit) return null;
  const sd = parseChildren(explicit.content)[0]; // SignedData SEQUENCE
  const sdKids = parseChildren(sd.content);
  let eci = null;
  for (const k of sdKids) {
    if (k.tag !== 0x30) continue;
    const kk = parseChildren(k.content);
    if (kk[0] && kk[0].tag === 0x06 && oidToStr(kk[0].content) === OID_TSTINFO) { eci = k; break; }
  }
  if (!eci) return null;
  const eciKids = parseChildren(eci.content);
  const exp = eciKids.find((k) => k.tag === 0xa0);
  if (!exp) return null;
  const octet = parseChildren(exp.content)[0];
  if (!octet || octet.tag !== 0x04) return null;
  return { tstInfoDer: octet.content, sd, sdKids };
}

export function parseTstInfo(tokenDer) {
  try {
    const ex = extractTstInfoBytes(tokenDer);
    if (!ex) return null;
    const ti = parseTLV(ex.tstInfoDer, 0);
    const k = parseChildren(ti.content);
    // version, policy, messageImprint, serialNumber, genTime, [accuracy], ...
    const policy = k[1] && k[1].tag === 0x06 ? oidToStr(k[1].content) : null;
    const mi = parseChildren(k[2].content); // SEQ{ algId, OCTET STRING }
    const hashed = mi[1] && mi[1].tag === 0x04 ? mi[1].content : Buffer.alloc(0);
    const serial = k[3] && k[3].tag === 0x02 ? k[3].content.toString('hex') : null;
    const gtTlv = k.find((x) => x.tag === 0x18);
    const genTimeIso = gtTlv ? genTimeToIso(gtTlv.content.toString('ascii')) : null;
    return {
      policy,
      serialHex: serial,
      messageImprintHex: hashed.toString('hex'),
      genTimeIso,
    };
  } catch {
    return null;
  }
}

// Map a signature/digest algorithm OID to a Node hash name (null => Ed25519).
function hashNameForSig(sigOid, digestOid) {
  switch (sigOid) {
    case OID_SHA256_RSA: case OID_ECDSA_SHA256: return 'sha256';
    case OID_SHA384_RSA: case OID_ECDSA_SHA384: return 'sha384';
    case OID_SHA512_RSA: return 'sha512';
    case OID_ED25519: return null;
    case OID_RSA_ENCRYPTION: default:
      // Generic rsaEncryption: the hash is carried by the digestAlgorithm.
      if (digestOid === OID_SHA512) return 'sha512';
      if (digestOid === OID_SHA384) return 'sha384';
      return 'sha256';
  }
}

// CMS SignedData signature check against the EMBEDDED signer certificate.
// Returns { verified, hardFail, reason?, signer? }. hardFail:true means the
// signature was present and affirmatively did NOT verify (tampered) -> the
// caller fails the timestamp. hardFail:false means we could not fully parse an
// exotic token -> the caller keeps the imprint+genTime verdict and marks the
// signature unverified.
function verifyCmsSignature(tokenDer) {
  let parsed;
  try {
    parsed = extractTstInfoBytes(tokenDer);
    if (!parsed) return { verified: false, hardFail: false, reason: 'no_tstinfo' };
  } catch (e) {
    return { verified: false, hardFail: false, reason: 'parse:' + (e && e.message) };
  }
  try {
    const { sdKids, tstInfoDer } = parsed;
    // certificates [0] IMPLICIT
    const certField = sdKids.find((k) => k.tag === 0xa0);
    if (!certField) return { verified: false, hardFail: false, reason: 'no_cert' };
    const certDer = parseChildren(certField.content)[0].raw;
    // signerInfos: the LAST SET (the first SET is digestAlgorithms).
    const sets = sdKids.filter((k) => k.tag === 0x31);
    if (sets.length < 2) return { verified: false, hardFail: false, reason: 'no_signerinfos' };
    const si = parseChildren(sets[sets.length - 1].content)[0];
    const siKids = parseChildren(si.content);
    const signedAttrs = siKids.find((k) => k.tag === 0xa0);
    if (!signedAttrs) return { verified: false, hardFail: false, reason: 'no_signed_attrs' };
    const digestAlgSeq = siKids.find((k, i) => k.tag === 0x30 && i >= 2);
    const digestOid = digestAlgSeq ? oidToStr(parseChildren(digestAlgSeq.content)[0].content) : OID_SHA256;
    // signatureAlgorithm = the SEQ that comes after signedAttrs.
    const saIdx = siKids.indexOf(signedAttrs);
    const sigAlgSeq = siKids.slice(saIdx + 1).find((k) => k.tag === 0x30);
    const sigOid = sigAlgSeq ? oidToStr(parseChildren(sigAlgSeq.content)[0].content) : OID_RSA_ENCRYPTION;
    const sigOctet = siKids.filter((k) => k.tag === 0x04).pop();
    if (!sigOctet) return { verified: false, hardFail: false, reason: 'no_signature' };
    const signature = sigOctet.content;

    // (1) the messageDigest signed attribute must equal hash(eContent).
    const hashName = hashNameForSig(sigOid, digestOid) || 'sha512'; // ed25519 hashes nothing; messageDigest still uses the digestAlg
    const mdHashName = hashNameForSig(OID_RSA_ENCRYPTION, digestOid);
    let mdAttr = null;
    for (const a of parseChildren(signedAttrs.content)) {
      const ak = parseChildren(a.content);
      const oid = oidToStr(ak[0].content);
      if (oid === OID_MESSAGE_DIGEST) {
        const vals = parseChildren(ak[1].content);
        mdAttr = vals[0].content;
      }
    }
    if (mdAttr) {
      const computed = crypto.createHash(mdHashName).update(tstInfoDer).digest();
      if (!computed.equals(mdAttr)) return { verified: false, hardFail: true, reason: 'message_digest_mismatch' };
    }

    // (2) the signature over the DER of the signedAttrs SET (RFC 5652 5.4: the
    // [0] IMPLICIT tag 0xA0 is re-tagged to the SET OF tag 0x31 for signing).
    const signedAttrsDer = Buffer.concat([Buffer.from([0x31]), signedAttrs.raw.slice(1)]);
    const cert = new crypto.X509Certificate(certDer);
    const pub = cert.publicKey;
    const keyType = pub.asymmetricKeyType;
    let ok;
    if (keyType === 'ed25519' || keyType === 'ed448') {
      ok = crypto.verify(null, signedAttrsDer, pub, signature);
    } else if (keyType === 'rsa' || keyType === 'rsa-pss') {
      ok = crypto.verify(mdHashName, signedAttrsDer, pub, signature);
    } else if (keyType === 'ec') {
      ok = crypto.verify(hashName, signedAttrsDer, pub, signature);
    } else {
      return { verified: false, hardFail: false, reason: 'unsupported_key:' + keyType };
    }
    if (!ok) return { verified: false, hardFail: true, reason: 'signature_invalid' };
    return { verified: true, hardFail: false, signer: cert.subject || null };
  } catch (e) {
    return { verified: false, hardFail: false, reason: 'cms:' + (e && e.message) };
  }
}

// ===========================================================================
// timestampDigest(sha256hex, opts) -> timestamp_evidence. NEVER throws.
// ===========================================================================
export async function timestampDigest(sha256hex, opts = {}) {
  const tsaUrl = opts.tsaUrl || process.env.KOLM_TSA_URL || DEFAULT_TSA_URL;
  const imprint = String(sha256hex == null ? '' : sha256hex).toLowerCase();
  const evidence = {
    alg: TIMESTAMP_ALG,
    message_imprint: imprint,
    timestamp: null,
    token_b64: null,
    tsa_url: tsaUrl,
    status: 'offline',
  };
  if (!/^[0-9a-f]{64}$/.test(imprint)) { evidence.reason = 'invalid_digest'; return evidence; }

  let reqDer;
  try {
    let nonce = null;
    try { nonce = crypto.randomBytes(16); } catch { nonce = null; }
    reqDer = buildTimeStampReq(imprint, { nonce, certReq: true });
  } catch (e) {
    evidence.reason = 'request_build_failed:' + (e && e.message);
    // External request could not be formed; optionally self-issue.
    return maybeSelfIssue(evidence, imprint, opts);
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 2000;
  let respBuf = null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => { try { ctrl.abort(); } catch { /* noop */ } }, timeoutMs);
    let resp;
    try {
      resp = await fetch(tsaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' },
        body: reqDer,
        signal: ctrl.signal,
      });
    } finally { clearTimeout(to); }
    if (!resp.ok) { evidence.reason = `tsa_http_${resp.status}`; return maybeSelfIssue(evidence, imprint, opts); }
    respBuf = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    evidence.reason = 'tsa_unreachable:' + (e && (e.name === 'AbortError' ? 'timeout' : e.message));
    return maybeSelfIssue(evidence, imprint, opts);
  }

  try {
    const parsed = parseTimeStampResp(respBuf);
    if (!parsed.ok) { evidence.reason = parsed.reason; return maybeSelfIssue(evidence, imprint, opts); }
    const info = parseTstInfo(parsed.tokenDer);
    if (!info) { evidence.reason = 'token_parse_failed'; return maybeSelfIssue(evidence, imprint, opts); }
    if (info.messageImprintHex !== imprint) { evidence.reason = 'imprint_mismatch'; return maybeSelfIssue(evidence, imprint, opts); }
    evidence.status = 'timestamped';
    evidence.token_b64 = parsed.tokenDer.toString('base64');
    evidence.timestamp = info.genTimeIso;
    evidence.serial = info.serialHex || null;
    evidence.policy = info.policy || null;
    evidence.source = 'tsa';
    return evidence;
  } catch (e) {
    evidence.reason = 'parse_failed:' + (e && e.message);
    return maybeSelfIssue(evidence, imprint, opts);
  }
}

// Opt-in internal-TSA fallback. Only triggers when explicitly requested via
// opts.fallbackSelfIssue or env KOLM_TSA_SELF_ISSUE=1; otherwise the contract
// outcome (status:'offline') is preserved exactly.
function maybeSelfIssue(evidence, imprint, opts) {
  const enabled = opts.fallbackSelfIssue === true || process.env.KOLM_TSA_SELF_ISSUE === '1';
  if (!enabled) return evidence;
  try {
    const self = selfIssueTimestamp(imprint, { signer: opts.selfSigner });
    if (self && self.status === 'timestamped') {
      self.tsa_url = evidence.tsa_url;
      self.fallback_from = evidence.reason || 'tsa_unreachable';
      return self;
    }
  } catch { /* keep the offline evidence */ }
  return evidence;
}

// ===========================================================================
// verifyTimestamp(evidence, digest) -> { ok, status, reason?, signature_verified,
//                                        genTime?, signer?, checks[] }. NEVER throws.
//
// `digest` is the value the timestamp is expected to bind (64-hex sha256). When
// omitted, evidence.message_imprint is used as the expected value (self-check).
// ===========================================================================
export function verifyTimestamp(evidence, digest) {
  const checks = [];
  const base = { ok: false, status: evidence && typeof evidence === 'object' ? evidence.status : undefined, checks };
  try {
    if (!evidence || typeof evidence !== 'object') return { ...base, reason: 'no_evidence' };
    if (evidence.status === 'offline') {
      checks.push({ name: 'timestamped', ok: false, detail: 'evidence.status=offline (no TSA token)' });
      return { ...base, reason: 'not_timestamped' };
    }
    const want = String(digest != null ? digest : (evidence.message_imprint || '')).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(want)) return { ...base, reason: 'invalid_digest' };

    const claimed = String(evidence.message_imprint || '').toLowerCase();
    const imprintMatch = claimed === want;
    checks.push({ name: 'message_imprint matches digest', ok: imprintMatch, detail: imprintMatch ? want : `evidence=${claimed.slice(0, 12)} want=${want.slice(0, 12)}` });
    if (!imprintMatch) return { ...base, reason: 'imprint_mismatch' };

    if (!evidence.token_b64) return { ...base, reason: 'no_token' };
    let tokenDer;
    try { tokenDer = Buffer.from(String(evidence.token_b64), 'base64'); }
    catch { return { ...base, reason: 'token_decode_failed' }; }

    const info = parseTstInfo(tokenDer);
    if (!info) return { ...base, reason: 'token_parse_failed' };

    const tokenMatch = info.messageImprintHex === want;
    checks.push({ name: 'token messageImprint == digest', ok: tokenMatch, detail: info.messageImprintHex });
    if (!tokenMatch) return { ...base, reason: 'token_imprint_mismatch' };

    if (evidence.timestamp && info.genTimeIso && String(evidence.timestamp) !== String(info.genTimeIso)) {
      checks.push({ name: 'genTime matches recorded timestamp', ok: false, detail: `token=${info.genTimeIso} evidence=${evidence.timestamp}` });
      return { ...base, reason: 'gentime_mismatch' };
    }
    checks.push({ name: 'genTime', ok: true, detail: info.genTimeIso || '(none)' });

    const sig = verifyCmsSignature(tokenDer);
    checks.push({ name: 'CMS signature (embedded cert)', ok: sig.verified, detail: sig.verified ? (sig.signer || 'verified') : (sig.reason || 'unverified') });
    if (sig.hardFail) return { ...base, reason: sig.reason || 'signature_invalid', signature_verified: false };

    return {
      ok: true,
      status: 'timestamped',
      genTime: info.genTimeIso,
      signature_verified: sig.verified === true,
      trust: 'embedded-cert',
      signer: sig.signer || null,
      serial: info.serialHex || null,
      checks,
    };
  } catch (e) {
    return { ...base, reason: 'verify_error:' + (e && e.message) };
  }
}

// ===========================================================================
// selfIssueTimestamp(sha256hex, opts) -> timestamp_evidence (source:'self').
//
// Builds a REAL RFC 3161 TimeStampToken (CMS SignedData over a TSTInfo) signed
// by a self-signed certificate. Used as the documented opt-in offline fallback
// and as a fully-offline fixture for verifyTimestamp. Never an external claim:
// the token is marked source:'self' and the cert is a kolm self-signed cert.
// ===========================================================================
export function selfIssueTimestamp(sha256hex, opts = {}) {
  const imprint = String(sha256hex == null ? '' : sha256hex).toLowerCase();
  const tsaUrl = opts.tsaUrl || 'kolm-self';
  const evidence = {
    alg: TIMESTAMP_ALG, message_imprint: imprint, timestamp: null,
    token_b64: null, tsa_url: tsaUrl, status: 'offline',
  };
  if (!/^[0-9a-f]{64}$/.test(imprint)) { evidence.reason = 'invalid_digest'; return evidence; }
  try {
    // RSA keypair (self-signed cert) unless a {privateKey,publicKey} signer is given.
    let privateKey; let publicKey;
    if (opts.signer && opts.signer.privateKey && opts.signer.publicKey) {
      privateKey = crypto.createPrivateKey(opts.signer.privateKey);
      publicKey = crypto.createPublicKey(opts.signer.publicKey);
    } else {
      const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      privateKey = kp.privateKey;
      publicKey = kp.publicKey;
    }
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
    const now = opts.at instanceof Date ? opts.at : new Date();
    const genTimeStr = gtString(now);
    const genTimeBuf = tlv(0x18, Buffer.from(genTimeStr, 'ascii'));
    const genTimeIso = genTimeToIso(genTimeStr);
    const serial = crypto.randomBytes(8);

    // ---- self-signed certificate ----
    const cn = derSeq(derSet(derSeq(derOid(OID_COMMON_NAME), derUtf8('kolm self-timestamp')))); // Name
    const notBefore = derGeneralizedTime(new Date(now.getTime() - 60_000));
    const notAfter = derGeneralizedTime(new Date(now.getTime() + 3650 * 24 * 3600_000));
    const tbs = derSeq(
      ctxExplicit(0, derInt(2)),               // version v3
      derInt(serial),                          // serialNumber
      algId(OID_SHA256_RSA),                   // signature alg
      cn,                                      // issuer
      derSeq(notBefore, notAfter),             // validity
      cn,                                      // subject
      spkiDer,                                 // subjectPublicKeyInfo (already a SEQ)
    );
    const certSig = crypto.sign('sha256', tbs, privateKey);
    const certDer = derSeq(tbs, algId(OID_SHA256_RSA), derBitString(certSig));

    // ---- TSTInfo ----
    const messageImprint = derSeq(algId(OID_SHA256), derOctet(Buffer.from(imprint, 'hex')));
    const tstInfo = derSeq(
      derInt(1),
      derOid(OID_KOLM_SELF_POLICY),
      messageImprint,
      derInt(serial),
      genTimeBuf,
    );

    // ---- signedAttrs (signed as a SET OF, embedded as [0] IMPLICIT) ----
    const eContentDigest = crypto.createHash('sha256').update(tstInfo).digest();
    const attrContentType = derSeq(derOid(OID_CONTENT_TYPE), derSet(derOid(OID_TSTINFO)));
    const attrMessageDigest = derSeq(derOid(OID_MESSAGE_DIGEST), derSet(derOctet(eContentDigest)));
    const attrSigningTime = derSeq(derOid(OID_SIGNING_TIME), derSet(genTimeBuf));
    const signedAttrsSet = derSet(attrContentType, attrMessageDigest, attrSigningTime);
    const attrsSignature = crypto.sign('sha256', signedAttrsSet, privateKey);
    const signedAttrsImplicit = Buffer.concat([Buffer.from([0xa0]), signedAttrsSet.slice(1)]);

    // ---- SignerInfo (issuerAndSerialNumber sid, RSA) ----
    const sid = derSeq(cn, derInt(serial));
    const signerInfo = derSeq(
      derInt(1),
      sid,
      algId(OID_SHA256),
      signedAttrsImplicit,
      algId(OID_RSA_ENCRYPTION),
      derOctet(attrsSignature),
    );

    // ---- SignedData / ContentInfo ----
    const encap = derSeq(derOid(OID_TSTINFO), ctxExplicit(0, derOctet(tstInfo)));
    // certificates [0] IMPLICIT SET OF Certificate -> [0] wraps the cert(s).
    const certificates = ctxExplicit(0, certDer);
    const signedData = derSeq(
      derInt(3),
      derSet(algId(OID_SHA256)),
      encap,
      certificates,
      derSet(signerInfo),
    );
    const contentInfo = derSeq(derOid(OID_SIGNED_DATA), ctxExplicit(0, signedData));

    evidence.status = 'timestamped';
    evidence.token_b64 = contentInfo.toString('base64');
    evidence.timestamp = genTimeIso;
    evidence.serial = serial.toString('hex');
    evidence.policy = OID_KOLM_SELF_POLICY;
    evidence.source = 'self';
    return evidence;
  } catch (e) {
    evidence.reason = 'self_issue_failed:' + (e && e.message);
    return evidence;
  }
}

export const RFC3161_SPEC = {
  version: RFC3161_VERSION,
  alg: TIMESTAMP_ALG,
  default_tsa: DEFAULT_TSA_URL,
  rfc: '3161',
  cms: 'RFC 5652',
  evidence_fields: ['alg', 'message_imprint', 'timestamp', 'token_b64', 'tsa_url', 'status'],
};
