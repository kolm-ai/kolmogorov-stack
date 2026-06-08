# Security Policy

kolm builds cryptographic attestation and audit tooling, so we hold our own code to an auditor-grade bar. This document covers how to report issues and what our signing/attestation model does — and does not — prove.

## Reporting a vulnerability

Email **security@kolm.ai** with details and, where possible, a reproduction. Please do not open public issues for security reports.

- **Acknowledgement:** within 2 business days.
- **Triage + severity:** within 5 business days.
- **Fix / mitigation target:** Critical 7 days · High 30 days · Medium 90 days.
- **Coordinated disclosure:** we will agree a disclosure date with you and credit you (opt-in).

Safe-harbor: good-faith research that respects user privacy, avoids data destruction, and does not degrade service is welcome and will not be pursued legally.

## Scope (highest priority)

The attestation/signing stack is the credibility core; report issues here first:

- `src/ed25519.js` — Ed25519 keypair, sign/verify, key loading, fingerprints.
- `src/auditor-attestation.js` — third-party (N+7) auditor attestation blocks + cross-checks.
- `src/intoto-receipt.js`, `src/intoto-slsa.js` — in-toto Statement v1 + DSSE envelope + SLSA provenance shape.
- `src/transparency-log.js`, `src/merkle.js` — RFC 6962/9162 append-only Merkle log + inclusion proofs.
- `src/secrets-vault.js`, `src/keys.js` — secret storage + key custody.

## Cryptographic conformance

- **Signatures:** Ed25519 (RFC 8037), via Node.js `node:crypto` — no re-implemented primitives.
- **Envelopes:** DSSE PAE (pre-authentication encoding) + in-toto Statement v1.
- **Transparency:** RFC 6962 / 9162 Merkle tree with C2SP signed-note checkpoints; inclusion proofs verifiable offline.
- **Supply chain:** SLSA Provenance v1 *shape*. We claim build-provenance structure, not a hardened-builder (SLSA L3) guarantee, and say so explicitly.

## Threat model — what a kolm receipt proves, and what it does not

**Proves:**
- The signed payload has not been altered since signing (tamper-evidence).
- It was signed by the holder of a specific Ed25519 private key, verifiable by anyone with the public key — **no shared secret required** (asymmetric provenance).
- For audited artifacts, a *separate* auditor key (distinct from the builder key; enforced) co-signed the stated observations (N+7 model).
- Inclusion in the append-only transparency log at a given position, verifiable offline against a signed checkpoint.

**Does NOT prove:**
- That the underlying computation was correct or the audited system is "secure" — a signature is key-custody proof, not a compute attestation.
- Anything if the signing key is compromised. Key custody is the operator's responsibility (see key-custody notes in `src/ed25519.js` / `src/keys.js`).
- HMAC (`signature`) blocks are a legacy symmetric integrity check inside a tenant boundary only — they are *not* third-party-verifiable; rely on `signature_ed25519` for provenance.

## Supported versions

The `main` branch receives security fixes. Pin a release and watch this repo for advisories.
