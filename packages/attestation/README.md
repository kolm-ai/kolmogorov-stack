# kolm-attestation

TEE attestation parsers for kolm BYOC deployments.

When an operator deploys a `.kolm` artifact inside a hardware Trusted Execution
Environment (AWS Nitro Enclaves, AMD SEV-SNP, Intel TDX, GCP/Azure
Confidential VMs), the TEE produces a signed report that proves *what code
is running, on what silicon*. This package parses those reports into a
normalized envelope so the kolm.ai BYOC store can pin the measurement on
the deployment.

## What it does today (v0.1)

- **Parse** each vendor's attestation format:
  - AWS Nitro Enclaves — COSE_Sign1 over CBOR (PCR0 = SHA-384 of EIF)
  - AMD SEV-SNP — 1184-byte binary AttestationReport
  - Intel TDX — variable-length quote with TD body
  - GCP CVM — dispatches to SEV-SNP or TDX based on `technology`
  - Azure CVM — Microsoft Azure Attestation JWT *or* raw SEV-SNP/TDX
  - Docker — software-only `sha256:<hex>` measurement
- **Extract** the workload measurement, vendor claims, and signing cert
  chain (where present).
- **Compare** an incoming attestation against an `expected` envelope
  (measurement match, vendor match, freshness).

## What it does NOT do yet

- **Cryptographic verification of the vendor signing chain.**
  - AWS Nitro: needs the AWS Nitro root certificate.
  - AMD SEV-SNP: needs the VCEK (versioned chip endorsement key) fetched
    from `https://kdsintf.amd.com/vcek/v1/...`.
  - Intel TDX: needs the Intel PCS cert chain.
  - Azure MAA: needs the JWKS fetched from the MAA endpoint.

Today the parsers expose the cert chain claims so the cryptographic
verification can plug in without an API change. The BYOC flow operates in
TOFU (trust on first use) mode: the operator's first attestation pins the
measurement, and any later attestation that doesn't match raises the alarm.

## Public API

```js
import { parseAttestation, verifyAttestation, extractMeasurement } from 'kolm-attestation';

// Parse a raw vendor payload into a normalized envelope.
const parsed = parseAttestation('aws-nitro', payload);
// { ok, target, vendor, measurement, claims, signing_cert_chain, parsed_at, errors }

// Compare against an expected measurement.
const result = verifyAttestation('aws-nitro', payload, {
  measurement: 'pcr0:sha384:abc...',
  vendor: 'aws',
});
// { valid, reasons, parsed }

// Just grab the measurement.
const m = extractMeasurement('sev-snp', reportBuffer);
// 'mrtd:sha384:abc...'
```

## Adding a new TEE target

Add a `src/<target>.js` exporting `parse<Target>Attestation(payload)`,
register it in `SUPPORTED_TARGETS` + `PARSERS` in `src/index.js`, and ship
unit tests under `tests/`. Each parser must return:

```ts
{
  vendor: 'aws' | 'amd' | 'intel' | 'gcp' | 'azure' | 'docker',
  measurement: string,          // canonical 'pcr0:sha384:...' / 'mrtd:...' / 'sha256:...'
  claims: object,               // vendor-specific extras
  signing_cert_chain: string[] | null,
}
```

## Tests

```bash
node --test packages/attestation/tests/
```
