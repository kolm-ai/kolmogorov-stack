# Govern — Receipts & Compliance (W921)

Frontier governance primitives for kolm's "the receipt is the proof" story.
Everything here is **additive**, dependency-free (node:crypto only), and reuses
the already-shipped `src/merkle.js` (RFC 6962/9162) and `src/intoto-slsa.js`
(in-toto v1 + SLSA Provenance v1 + DSSE) modules.

## Modules

| Module | What it does |
|---|---|
| `src/transparency-log.js` | Append-only, **two-way-verifiable** log: an Ed25519/SHA-256 **hash chain** (tamper-evident, no secret needed to verify — unlike the HMAC chain in `src/audit.js`) PLUS an **RFC 6962 Merkle Tree Head** with O(log n) inclusion proofs and a **C2SP signed-note checkpoint**. |
| `src/transparency-anchor.js` | **Merkle-tree BATCH anchoring** of per-call receipts. `governReceiptBatch(receipts) -> {merkle_root, leaves, inclusion_proofs}`. One transparency-log entry witnesses thousands of receipts; hot path is enqueue-only (one SHA-256). Two-level offline verify. |
| `src/govern-provenance.js` | `buildSlsaProvenance(artifact) -> in-toto v1 Statement`. Thin artifact-shaped facade over `intoto-slsa.js`. Signs to a DSSE envelope; verifies subject digests against the real bytes. **SLSA Build L2 shape** (never claims L3). |
| `src/govern-drift.js` | Standard drift statistics: **PSI** (0.1/0.25 ladder, epsilon-smoothed), **MMD** (Gretton-2012 unbiased U-statistic + RBF + median heuristic + permutation p-value) and **ADWIN2** (Bifet & Gavaldà). Corroborating evidence, never flips a primary verdict. |
| `src/compliance-export.js` | `complianceExport({framework}) -> evidence bundle` mapping kolm's on-disk controls onto **SOC 2 / GDPR / EU AI Act**. Plus live **Art. 12** logging-conformance, **Art. 72** post-market report, and a signed **Art. 12 log-stream export**. |
| `src/compliance-c2pa.js` | **C2PA 2.x** content credentials for text outputs: `c2pa.hash.data` hard binding + `c2pa.actions.v2` (`digitalSourceType = trainedAlgorithmicMedia`, EU AI Act Art. 50(2)) + COSE_Sign1 Ed25519 signature, vanilla-Node CBOR. |
| `src/govern-routes.js` | `register(r, deps)` mounts the HTTP surface with one call (no `router.js` edit). |

## HTTP surface (`register(r, deps)`)

All routes are auth-required; `tenant_id` is forced from `req.tenant_record.id`.

```
POST /v1/govern/anchor/batch                 Merkle-batch + anchor receipts
GET  /v1/govern/anchor/status                batcher / anchoring status
POST /v1/govern/anchor/verify                two-level offline anchor verify
POST /v1/govern/transparency/append          append an entry to the tlog
GET  /v1/govern/transparency/head            signed Tree Head + chain verify
GET  /v1/govern/transparency/proof/:seq      inclusion proof for an entry
POST /v1/govern/provenance/build             in-toto/SLSA attestation
POST /v1/govern/provenance/verify            verify a DSSE attestation
POST /v1/govern/c2pa/sign                     C2PA content credential
POST /v1/govern/c2pa/verify                   verify a C2PA manifest
GET  /v1/govern/drift/standard                PSI/MMD/ADWIN signals
GET  /v1/govern/compliance/frameworks         list supported frameworks
GET  /v1/govern/compliance/export             framework evidence bundle
GET  /v1/govern/compliance/ai-act/art12       Art. 12 logging conformance
GET  /v1/govern/compliance/ai-act/art72       Art. 72 post-market report
GET  /v1/govern/compliance/ai-act/art12-export signed Art. 12 log stream
```

`deps` is an injectable seam: `{ store, verifyAuditChain, listAuditEvents,
computeDriftSignals, getSigner, getLifecycle, retentionDays, rekorSubmitFn,
batcher }`. Every dep is optional; the surface degrades gracefully (e.g. no
`rekorSubmitFn` ⇒ anchoring stays `state:'local'` with a kolm-signed checkpoint;
no signer ⇒ provenance returns an unsigned Statement).

## Verifying a receipt anchor offline (two levels, no kolm, no network)

```js
import { verifyReceiptAnchor } from './src/transparency-anchor.js';
const v = verifyReceiptAnchor({ receipt, anchor, pinnedLogKeyPem });
// v.level_a.ok  -> receipt is included in the batch Merkle root  (RFC 9162)
// v.level_b.ok  -> the batch root was witnessed by a signed checkpoint
```

Level A is pure SHA-256 over the receipt body (minus the non-signed `anchor`
block). Level B is one Ed25519 verify against a pinned log key. Tampering one
byte of the receipt fails Level A; a wrong/forged checkpoint key fails Level B.

## Constraints (no overclaiming)

- **SLSA**: Build **L2 shape** — signed and non-forgeable because the Ed25519
  key is custodied; **NOT** Build L3 (which requires a hardened, identity-bound
  builder kolm does not provide). The conformance string is re-exported from
  `intoto-slsa.js` so it can only ever say what that module says.
- **C2PA**: the manifest is a structurally-correct C2PA 2.x manifest with a
  **real** cryptographic hard binding and a **real** COSE_Sign1 Ed25519
  signature. Full CAI **trust-list** conformance requires the reference
  `c2patool`/`c2pa-rs` Reader and is reported as a limitation, never asserted.
  The tamper-evidence property (any output byte change breaks `c2pa.hash.data`)
  is cryptographically real and tested.
- **Compliance export**: coverage gaps are **recorded, not hidden**; a broken
  audit chain forces `conforms:false` loudly; missing retention is flagged
  `retention_policy_not_configured` (never assumed met); findings never
  fabricate evidence ids.

## Tests

`tests/wave921-govern-receipts-compliance.test.js` — 71 lock-in tests across all
six specs plus the route surface. The reused crypto primitives are covered by
`tests/wave921-govern-crypto.test.js` (39 tests). Zero new package.json deps.
