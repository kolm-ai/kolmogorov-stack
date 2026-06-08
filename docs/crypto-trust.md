# Crypto trust services

These are the verifiability table-stakes that let a buyer prove a kolm Agent
Security-Review report was not tampered with, and that the key behind it is still
trusted, WITHOUT trusting kolm as the sole root. Three independent services layer
on top of the Ed25519 signature that already protects every report.

| Layer | Question it answers | Service |
| ----- | ------------------- | ------- |
| Signature (existing) | Was this report signed by the holder of the embedded key, and is it byte-for-byte unaltered since? | `src/ed25519.js`, `src/attestation-report-builder.js` |
| Issuer provenance (existing) | Is that key one kolm publishes (live signer / `public/keys/kolm-issuers.json`)? | `_issuerProvenance` in `src/audit-routes.js`, `issuerProvenance` in `public/kolm-audit-verify.js` |
| **Trusted timestamp (M3)** | When did this evidence exist? Proven by an INDEPENDENT third party, not kolm's clock. | `src/rfc3161-timestamp.js` |
| **Transparency log (M4)** | Is this evidence recorded in an append-only, Merkle-witnessed public log with an offline inclusion proof? | `src/transparency-log.js`, `src/transparency-log-routes.js` |
| **Key lifecycle (M5)** | Is the signing key still trusted RIGHT NOW, or has it been revoked / rotated? | `src/key-revocation.js` |

The later report-embedding wave carries the M3/M4 outputs in the signed report
envelope under these fields (this track builds the SERVICES; it does not edit the
report builder):

```jsonc
{
  "timestamp_evidence": {
    "alg": "sha256",
    "message_imprint": "<64-hex sha256 of the timestamped bytes>",
    "timestamp": "2026-06-09T12:30:45Z",      // ISO genTime, or null when offline
    "token_b64": "<base64 DER RFC 3161 token>", // null when offline
    "tsa_url": "https://freetsa.org/tsr",
    "status": "timestamped"                     // or "offline"
  },
  "log_checkpoint": {
    "url": "https://kolm.ai/v1/transparency-log",
    "tree_size": 1024,
    "root_hash": "<64-hex RFC 6962 Merkle root>",
    "tree_head_signature": "<base64 Ed25519 over the C2SP note>"
  }
}
```

Because both fields live in the SIGNED payload, any post-hoc edit to them already
breaks the Ed25519 signature. The verifier surfaces them as additive evidence.

---

## M3 - RFC 3161 trusted timestamping (`src/rfc3161-timestamp.js`)

A signature proves WHO and WHAT, never WHEN. A trusted timestamp closes that gap:
a public RFC 3161 Time-Stamping Authority (TSA) counter-signs a SHA-256 hash of
the report at a point in time, so a buyer can prove the evidence existed no later
than that instant without trusting kolm's clock.

```js
import { timestampDigest, verifyTimestamp } from './src/rfc3161-timestamp.js';

const evidence = await timestampDigest(sha256hex);   // never throws
// evidence.status === 'timestamped' | 'offline'

const v = verifyTimestamp(evidence, sha256hex);      // fully offline
// v.ok, v.signature_verified, v.genTime, v.trust === 'embedded-cert'
```

- `timestampDigest(sha256hex, opts?)` POSTs a DER `TimeStampReq` to the TSA
  (`KOLM_TSA_URL`, default `https://freetsa.org/tsr`) with a 2s timeout, parses
  the `TimeStampResp`, confirms the returned token binds OUR imprint, and returns
  `timestamp_evidence`. On any failure (network down, TSA refusal, parse error)
  it returns `status:'offline'` and NEVER throws - timestamping is additive
  evidence, never a hard dependency.
- `verifyTimestamp(evidence, digest?)` re-derives every claim from the token
  bytes, fully offline:
  1. the token's `messageImprint` equals the digest,
  2. the token's `genTime` equals the recorded `timestamp`,
  3. the CMS `SignedData` signature over the `TSTInfo` verifies against the
     signer certificate embedded in the token.
  Step 3 is reported as `trust:'embedded-cert'`: it proves the token has not been
  altered since the TSA emitted it (tamper-evidence). Chaining the TSA cert to a
  trusted CA root is a deployment policy choice on top of this.
- ASN.1/DER and the CMS walk are hand-rolled with `node:crypto` only (no
  dependency), so the module is a leaf in the import graph and ports to an SDK.

### Self-issued fallback (opt-in)

`selfIssueTimestamp(sha256hex)` produces a REAL RFC 3161 token signed by a kolm
self-signed certificate. It is weaker than an independent TSA (kolm is asserting
its own clock) and is clearly marked `source:'self'`. It is OFF by default;
enable the fallback in `timestampDigest` with `opts.fallbackSelfIssue` or
`KOLM_TSA_SELF_ISSUE=1`. It also serves as the fully-offline verifier fixture.

### Configuration

| Env | Default | Meaning |
| --- | ------- | ------- |
| `KOLM_TSA_URL` | `https://freetsa.org/tsr` | TSA endpoint (e.g. `http://timestamp.sectigo.com`, `http://timestamp.digicert.com`) |
| `KOLM_TSA_SELF_ISSUE` | unset | `1` enables the self-issued fallback when the external TSA is unreachable |

---

## M4 - transparency log (`src/transparency-log.js` + `-routes.js`)

An append-only, tamper-evident log whose integrity is provable two independent
ways: a SHA-256 hash chain AND an RFC 6962 / RFC 9162 Merkle tree. Any entry has
an O(log n) inclusion proof that verifies offline against a signed Tree Head
(checkpoint), the exact Certificate-Transparency / Sigstore-Rekor witness model.

### Public read surface (no account)

```
GET /v1/transparency-log/size                 -> { tree_size, root_hash }
GET /v1/transparency-log/entries/:seq         -> one entry + hashes
GET /v1/transparency-log/entries?start&end    -> a page of entries (<= 1000)
GET /v1/transparency-log/proof/:seq           -> RFC 9162 inclusion proof + checkpoint
GET /v1/transparency-log/checkpoints/latest   -> current SIGNED tree head
GET /v1/transparency-log/checkpoints?from&to  -> history of signed heads (by tree_size)
```

Verify an inclusion proof offline:

```js
import { verifyInclusionProof, verifyTreeHeadSignature } from './src/transparency-log.js';

const { proof, checkpoint } = await (await fetch('/v1/transparency-log/proof/3')).json();
verifyTreeHeadSignature(checkpoint).ok;                       // checkpoint is signed
verifyInclusionProof(proof, { signedTreeHead: checkpoint }).ok; // entry is in that signed tree
```

### Witness co-signing HOOK (optional)

A single operator signing its own log is a closed system: it could present a
SPLIT VIEW (different histories to different viewers). A WITNESS is an independent
party that counter-signs the SAME checkpoint note; a viewer who trusts the
witness can detect a split view. This is a HOOK, not a mandate - by default there
is no witness and the `witnesses` field is absent.

Wire one of two ways:

```js
import { setTransparencyWitness } from './src/transparency-log.js';
setTransparencyWitness({ privateKey, publicKey });   // in-process Ed25519 signer
```

```
KOLM_TLOG_WITNESS_KEY=<PEM Ed25519 private key>      # loaded lazily, env-driven
```

Each checkpoint then carries a `witnesses[]` array; verify with
`verifyCosignedTreeHead(checkpoint, { witnessKeys: [pinnedPem] })`.

| Env | Default | Meaning |
| --- | ------- | ------- |
| `KOLM_TLOG_ORIGIN` | `kolm.ai/transparency/v1` | the public log origin label |
| `KOLM_TLOG_WITNESS_KEY` | unset | PEM Ed25519 witness key for checkpoint co-signing |

---

## M5 - issuer key lifecycle (`src/key-revocation.js`)

An Ed25519 signature is only as trustworthy as the key behind it. If a signing
key is compromised, every report it ever signed must STOP being accepted even
though the signature still verifies. This is the authoritative, persisted answer.

```
GET  /v1/audit/issuer-key/:fp/status   (public)  -> { fingerprint, valid, status, revoked_at, reason, next_rotation_at }
POST /v1/audit/issuer-key/:fp/revoke   (admin)   -> marks the key revoked
```

```js
import { isRevoked, revoke, rotateKey, status } from './src/key-revocation.js';

revoke(fp, 'key compromised');     // reports signed by fp now fail trust
rotateKey({ old_fp, new_fp });     // routine rotation: old -> 'rotated' (still valid), new -> 'live'
status(fp);                        // { status: 'live' | 'rotated' | 'revoked', valid, ... }
```

- `status` vocabulary: `live` (default for any key with no row), `rotated`
  (no longer the current signer, but historical signatures stay valid - rotation
  is not compromise), `revoked` (`valid:false`; reports signed by it are refused).
- Persisted in the global `issuer_key_status` table (NOT tenant-scoped: issuer
  keys are operator/product-level, not customer data).
- The admin route is gated by `ADMIN_KEY` (authenticate with `Bearer <ADMIN_KEY>`
  so `authMiddleware` sets `req.is_admin`, or send `x-admin-key: <ADMIN_KEY>`).

### How revocation reaches the verdict

- Server route `POST /v1/audit/report/verify`: recomputes the embedded key
  fingerprint, consults the revocation store, and returns `trusted:false` +
  `reason:'issuer_key_revoked'` for a report signed by a revoked key (the
  signature itself still verifies; trust is withdrawn).
- Offline browser verifier `public/kolm-audit-verify.js`: a browser cannot know
  revocation on its own, so the caller passes a revocation source fetched once
  from the public feed:

  ```js
  verifyAuditReport(report, { revokedFingerprints: ['<fp>'] });
  verifyAuditReport(report, { issuerKeyring: keyringJson }); // status:'revoked' or revoked:true
  ```

  A revoked key returns `{ ok:false, reason:'issuer_key_revoked' }` before the
  signature step, so a revoked key is refused even where WebCrypto Ed25519 is
  unavailable. Both options are optional; with neither, behavior is unchanged.

The published keyring `public/keys/kolm-issuers.json` carries rotation metadata
(`rotation.policy_days`, per-issuer `next_rotation_at`) and an offline
`revocations: []` feed the browser verifier can consume.

---

## Verifier-side checks (`public/kolm-audit-verify.js`)

`verifyAuditReport` gained, all gracefully optional (no behavior change unless
the relevant field/opt is present):

- a tier-3 revocation gate (see M5),
- an informational `trusted timestamp present` check when `timestamp_evidence`
  is present,
- an informational `transparency-log checkpoint present` check when
  `log_checkpoint` is present.

The optional evidence checks never flip the verdict on their own - both fields
are inside the signed payload, so tampering already breaks the Ed25519 check.
