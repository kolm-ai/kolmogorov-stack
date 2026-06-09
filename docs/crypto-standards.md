# Crypto standards: how to verify a kolm report

A kolm Agent Security-Review report is a signed JSON envelope. The signature is
PRIMARY and bespoke, but the same report can be re-expressed in formats the wider
ecosystem already speaks, so a buyer can verify it with off-the-shelf tooling and
no kolm code. This page lists four independent ways to check the same report:

1. Native Ed25519 (the primary signature already on every report).
2. JWS / JOSE (RFC 7515) for any JOSE verifier or JWT library.
3. DSSE / in-toto + SLSA provenance for supply-chain gates (cosign, slsa-verifier).
4. The transparency-log inclusion proof (RFC 9162) plus the RFC 3161 timestamp.

All four bind the SAME canonical bytes. The canonical form is produced by
`canonicalizeReport(report)` in `src/attestation-report-builder.js`: recursive,
key-sorted, whitespace-free JSON with three fields excluded from the signed bytes
(`signature_ed25519`, `timestamp_evidence`, `log_checkpoint`). The first is the
signature itself; the other two are detached evidence attached after signing.

Throughout, "report digest" means `sha256(canonicalizeReport(report))` as a
64-character lowercase hex string. That is the value the transparency log and the
RFC 3161 timestamp both bind to.

---

## (a) Native Ed25519

The report carries a `signature_ed25519` block:

```jsonc
{
  "signature_ed25519": {
    "spec": "kolm-ed25519-v1",
    "alg": "ed25519",
    "public_key": "-----BEGIN PUBLIC KEY----- ...",
    "key_fingerprint": "<first 32 hex of sha256(SPKI DER)>",
    "signature": "<base64url raw 64-byte Ed25519 signature>",
    "signed_at": "<ISO 8601, equal to report.generated_at>"
  }
}
```

To verify with only Node's standard library:

```js
import crypto from 'node:crypto';
import { canonicalizeReport } from './src/attestation-report-builder.js';

const block = report.signature_ed25519;
const canonical = canonicalizeReport(report);          // excludes the block
const sig = Buffer.from(block.signature, 'base64url');
const ok = crypto.verify(null, Buffer.from(canonical, 'utf8'), block.public_key, sig);
```

`verifyReport(report)` in `src/attestation-report-builder.js` does this plus a
fingerprint cross-check and a `signed_at == generated_at` check, and returns a
check trail. The browser verifier `public/kolm-audit-verify.js` reproduces the
exact bytes with no import. No secret, no account, no kolm server is required.

The public key is also published as an RFC 8037 OKP JWK (see below), so a
verifier can pin a known key instead of trusting the one embedded in the report.

---

## (b) JWS / JOSE (RFC 7515)

`src/jws-envelope.js` re-expresses the report as a JWS General JSON
serialization. The JWS payload is the canonical report bytes; the protected
header is `{ "alg": "EdDSA", "typ": "JWT", "kid": "<fingerprint>" }`.

```js
import { toJwsGeneralJson, verifyJws, publicJwk } from './src/jws-envelope.js';

const jws = toJwsGeneralJson(report);   // uses the env/cached signer
// {
//   "payload": "<base64url(canonicalizeReport(report))>",
//   "signatures": [
//     { "protected": "<base64url({alg,typ,kid})>", "signature": "<base64url>" }
//   ]
// }

const ok = verifyJws(jws, signerPublicKeyPem);   // true / false, never throws
const jwk = publicJwk(signerPublicKeyPem);        // RFC 8037 OKP JWK
```

The signature is Ed25519 over the RFC 7515 JWS Signing Input
`ASCII(BASE64URL(protected) "." BASE64URL(payload))`. Because this signing input
differs from the native one, the JWS signature bytes are not the same as
`signature_ed25519.signature`; both nonetheless cover the same report content.

Verifying with a third-party JOSE library, using the OKP JWK:

```js
import { generalVerify } from 'jose';                  // npm i jose
import { importJWK } from 'jose';

const key = await importJWK({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }, 'EdDSA');
const { payload } = await generalVerify(jws, key);     // throws on a bad sig
const report = JSON.parse(new TextDecoder().decode(payload));
```

The JWK shape (`src/ed25519.js` `publicKeyJwk`):

```json
{ "kty": "OKP", "crv": "Ed25519", "x": "<base64url raw 32-byte key>",
  "use": "sig", "alg": "EdDSA", "kid": "<fingerprint>" }
```

### COSE / CBOR mirror (described, no dependency)

The same EdDSA signature maps cleanly to a COSE_Sign1 structure (RFC 9052) for
constrained or embedded verifiers, without kolm pulling in a CBOR encoder:

- protected header: a CBOR map `{ 1: -8 }` where label 1 is `alg` and -8 is
  `EdDSA` (RFC 9053).
- payload: the canonical report bytes (the same `canonicalizeReport(report)`).
- the signature is computed over the COSE `Sig_structure` with context string
  `"Signature1"`, which plays the same role the JWS Signing Input plays here.

A COSE verifier that builds that Sig_structure and runs Ed25519 verification
checks the identical report content. Only the framing (CBOR vs base64url JSON)
changes.

---

## (c) DSSE / in-toto + SLSA provenance

`src/slsa-provenance.js` emits the report as an in-toto Statement v1 carrying a
SLSA provenance v1 predicate, wrapped in a DSSE envelope and Ed25519-signed. This
lets a buyer feed a kolm report into the same supply-chain gate that checks their
container provenance.

```js
import { toInTotoStatement, toDsseEnvelope, verifyDsse } from './src/slsa-provenance.js';

const stmt = toInTotoStatement(report);
// {
//   "_type": "https://in-toto.io/Statement/v1",
//   "subject": [{ "name": "<report_id>", "digest": { "sha256": "<report digest>" } }],
//   "predicateType": "https://slsa.dev/provenance/v1",
//   "predicate": {
//     "buildDefinition": { "buildType": "https://kolm.ai/asr-audit/v1",
//       "externalParameters": { ... }, "internalParameters": { ... },
//       "resolvedDependencies": [{ "name": "audit-events",
//         "digest": { "sha256": "<evidence digest>" } }] },
//     "runDetails": { "builder": { "id": "https://kolm.ai" },
//       "metadata": { "invocationId": "<report_id>", "startedOn": "...",
//         "finishedOn": "..." } }
//   }
// }

const env = toDsseEnvelope(stmt);          // signs with the env/cached signer
const ok = verifyDsse(env, signerPublicKeyPem);   // true / false, never throws
```

The subject digest is the report digest (`sha256(canonicalizeReport(report))`),
so the provenance names the exact report. The input AuditEvents digest
(`evidence_digest.value`) rides as a resolved dependency, which is its SLSA role:
the materials the build consumed.

The DSSE envelope:

```json
{ "payloadType": "application/vnd.in-toto+json",
  "payload": "<base64(statement JSON)>",
  "signatures": [{ "keyid": "<fingerprint>", "sig": "<base64 Ed25519 over PAE>" }] }
```

The signature covers the DSSE Pre-Authentication Encoding (PAE), not the bare
payload:

```
PAE("application/vnd.in-toto+json", body) =
  "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body
```

where SP is a single space (0x20) and LEN is the ASCII-decimal byte length.
Signing over PAE is what defeats a payloadType-confusion attack. The same
envelope verifies under cosign or any DSSE library that knows the public key.

---

## (d) Transparency-log inclusion proof (RFC 9162) plus RFC 3161 timestamp

These two are DETACHED evidence: they are issued after the report is signed and
they reference the report digest, so they are not covered by the signature (and
are excluded from the canonical bytes). They answer "when did this exist" and
"is it in an append-only public log", independent of kolm's word.

### Transparency-log inclusion

Every delivered report is anchored in the global, Merkle-witnessed transparency
log when it is signed. The report carries a `log_checkpoint`:

```jsonc
{
  "log_checkpoint": {
    "origin": "kolm.ai/transparency/v1",
    "tree_size": 1024,
    "root_hash": "<64-hex RFC 6962 Merkle root>",
    "leaf_hash": "<64-hex leaf>",
    "seq": 21,
    "report_digest": "<report digest this leaf commits>"
  }
}
```

Fetch the inclusion proof for that `seq` from the PUBLIC read endpoint. The proof
response carries the RFC 9162 fields at the TOP LEVEL:

```
GET /v1/transparency-log/proof/:seq
{
  "ok": true,
  "leaf_index": 21,
  "tree_size": 1024,
  "audit_path": ["<hex>", "<hex>", ...],
  "root_hash": "<64-hex>",
  "leaf_hash": "<64-hex>",
  "proof": { ... },        // backward-compatible nested copy
  "checkpoint": { ... }    // current signed tree head
}
```

Verify it offline with `verifyInclusionProof` in `src/transparency-log.js`, which
is pure RFC 9162 SHA-256 over the supplied bytes (no network, no secret):

```js
import { verifyInclusionProof } from './src/transparency-log.js';

const v = verifyInclusionProof({
  leaf_hash: resp.leaf_hash,
  leaf_index: resp.leaf_index,
  tree_size: resp.tree_size,
  audit_path: resp.audit_path,
  root_hash: resp.root_hash,
}, { signedTreeHead: resp.checkpoint });   // binds the proof to the signed head
```

Cross-check that `root_hash` matches the signed checkpoint (the checkpoint's
Ed25519 signature, and any witness cosignature, verify under the same scheme),
and that `leaf_hash` matches `log_checkpoint.leaf_hash` from the report. That
chain proves the report digest is recorded in the published log state.

### RFC 3161 trusted timestamp

The paid report additionally carries an RFC 3161 timestamp over the report
digest, proving the report existed no later than the Time-Stamping Authority
genTime, independent of kolm's clock:

```jsonc
{
  "timestamp_evidence": {
    "alg": "sha256",
    "message_imprint": "<report digest>",
    "timestamp": "2026-06-09T12:30:45Z",
    "token_b64": "<base64 DER RFC 3161 token>",
    "tsa_url": "https://freetsa.org/tsr",
    "status": "timestamped"
  }
}
```

Verify it fully offline with `verifyTimestamp` in `src/rfc3161-timestamp.js`:

```js
import { verifyTimestamp } from './src/rfc3161-timestamp.js';
const v = verifyTimestamp(report.timestamp_evidence, reportDigest);
// v.ok, v.signature_verified, v.genTime
```

Confirm `message_imprint` equals the report digest you computed in step (a), so
the timestamp is bound to this exact report and cannot be re-pointed at another.

---

## Summary

| Path | Format | Module | Answers |
| ---- | ------ | ------ | ------- |
| (a) | Native Ed25519 over canonical JSON | `src/ed25519.js`, `src/attestation-report-builder.js` | who signed, unaltered since |
| (b) | JWS General JSON (RFC 7515) + OKP JWK | `src/jws-envelope.js` | same, via any JOSE verifier |
| (c) | in-toto + SLSA provenance in DSSE | `src/slsa-provenance.js` | same, via supply-chain gates |
| (d) | RFC 9162 inclusion proof + RFC 3161 timestamp | `src/transparency-log.js`, `src/rfc3161-timestamp.js` | recorded in a public log, existed by a time |

Questions: dev@kolm.ai
