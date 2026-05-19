# kolm verify

Run the 7-check audit on a `.kolm` artifact: manifest signature, content
identifier (CID), HMAC chain, receipt body signatures, provenance
credential, K-score gate, and eval coverage. Use this before promoting
an artifact to production.

## Usage

```
kolm verify <artifact.kolm>
kolm verify <artifact.kolm> --strict        # also re-runs the frozen eval set
kolm verify <artifact.kolm> --json          # machine-readable result
```

## What gets checked

1. **Manifest signature**: the top-level Ed25519 signature over the manifest.
2. **Content identifier**: recompute the artifact CID, compare to the manifest.
3. **HMAC chain**: every receipt is bound to its predecessor.
4. **Receipt body signatures**: each receipt is individually signed.
5. **Provenance credential**: the actor key fingerprint matches the manifest.
6. **K-score gate**: frozen-eval result meets or exceeds the declared gate.
7. **Eval coverage**: every declared eval id is present in the receipt chain.

## Exit codes

- `0`: all 7 checks pass.
- `1`: at least one check failed (full reason printed).
- `2`: file unreadable or malformed.

## See also

- `/docs/rs-1` for the receipts spec.
- `/verify-prod` for the hosted browser verifier.
- `kolm inspect` for a passive manifest read without re-checking signatures.
