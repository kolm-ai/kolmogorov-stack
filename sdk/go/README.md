# kolm Go SDK

Offline, dependency-free verification of a signed **kolm Agent Security-Review
evidence report** — plus a thin client for the kolm.ai audit API.

A kolm report is an Ed25519-signed JSON envelope mapping an AI-agent fleet's
findings to SOC 2, ISO/IEC 42001, NIST AI RMF, the EU AI Act, the OWASP LLM &
Agentic Top 10, and MITRE ATLAS. This module lets a buyer's Go or Java security
team confirm a report is genuine and untouched **without calling kolm at all**.

```go
import kolm "github.com/kolm-ai/kolm-go"

v, err := kolm.VerifyReport(reportJSON, kolm.DefaultKeyring())
if err != nil {
    log.Fatalf("not a verifiable kolm report: %v", err)
}
if v.Trusted() {
    log.Printf("trusted evidence from %s (%s), fingerprint %s",
        v.IssuerKID, v.IssuerStatus, v.KeyFingerprint)
}
```

## The killer feature: offline verification

The signature covers a canonical serialization of the report. `VerifyReport`
rebuilds those exact bytes and checks the embedded Ed25519 signature with the Go
standard library only — **no network, no kolm account, no shared secret**. A
single altered byte (a downgraded readiness number, a deleted finding, a flipped
`tamper_evident` flag) breaks the check.

It returns a **two-tier verdict**:

| Tier | Field | Meaning |
|------|-------|---------|
| 1 | `Tier1Signature` | The report is signed by the holder of the embedded key **and is untampered**. |
| 2 | `Tier2Issuer` | That embedded key is one **kolm publishes** (it is in the trusted keyring). |

Only act on a report when **both** are true — use `verdict.Trusted()`. Checking
Tier 1 alone would accept a forgery that an attacker re-signed with their *own*
key after tampering; Tier 2 is what binds the key to kolm.

```go
v, err := kolm.VerifyReport(reportJSON, kolm.DefaultKeyring())
switch {
case err != nil:
    // Not a verifiable kolm report (bad JSON, no signature block, …).
case !v.Tier1Signature:
    // Tampered or rogue-signed: v.Reason explains.
case !v.Tier2Issuer:
    // Genuine signature, but the key is not a recognized kolm issuer.
default:
    // v.Trusted() == true. Inspect v.IssuerStatus ("production" vs "demo").
}
```

Every `verdict.Checks` entry records a real step (canonical rebuild, fingerprint
cross-check, Ed25519 verify, `signed_at` consistency, issuer match) so you can
render the same step-by-step report the kolm `/verify` page shows.

## Install

```sh
go get github.com/kolm-ai/kolm-go
```

The package name is `kolm`. It has **zero third-party dependencies** — only the
Go standard library (`crypto/ed25519`, `crypto/x509`, `encoding/pem`, …).

## Build & test require the Go toolchain

This SDK was authored and reviewed for correctness, but the Go toolchain is **not
installed in the environment where it was generated**, so it was **not compiled
or run there**. Build and test it yourself with Go 1.21 or newer:

```sh
cd sdk/go
go vet ./...
go test ./...        # runs the table-driven tests + the verified example
go test -run Example # runs the offline-verify example with output assertion
```

`go test` verifies the committed sample report in `testdata/sample-report.json`
against the embedded keyring — a passing run is proof that the Go canonicalizer
reproduces the Node/browser signer byte-for-byte.

## Verify a report from the command line

```sh
go run ./examples/offline-verify testdata/sample-report.json
```

Exits 0 only when the report is `Trusted()`, so it drops straight into CI.

## Byte-for-byte canonicalization

`Canonicalize(value any) []byte` reproduces `canonicalize()` from
`src/attestation-report-builder.js` (Node) and `public/kolm-audit-verify.js`
(browser WebCrypto) **exactly**. The algorithm is recursive, key-sorted,
whitespace-free JSON with the `signature_ed25519` block excluded, signed over its
UTF-8 bytes. The fidelity that matters:

- **Numbers** follow ECMAScript `Number::toString` (the algorithm
  `JSON.stringify` uses): shortest round-trip digits, with exponential notation
  only for magnitudes `>= 1e21` or `< 1e-6` (`1e+21`, `1e-7`), and `0` for both
  `+0`/`-0`. Non-finite values serialize to `null`.
- **Strings** follow ECMAScript `QuoteJSONString`: only `"`, `\`, and the C0
  control characters are escaped. kolm does **not** escape `<`, `>`, `&`, `/`,
  `U+2028`, or `U+2029` (Go's `encoding/json` escapes several of these by
  default — which is why this SDK ships its own emitter).
- **Object keys** sort by **UTF-16 code unit**, matching JavaScript's default
  `Array.prototype.sort`. For supplementary-plane characters (e.g. emoji) this
  differs from raw UTF-8 byte order, and the SDK gets it right.
- **`null`** is preserved (it is a value, not an absent key).

## Keyring

`DefaultKeyring()` returns the kolm issuers embedded at build time (a `go:embed`
copy of `public/keys/kolm-issuers.json`), so verification needs nothing on disk.

To verify against the **live** keyring — for example to accept a freshly rotated
production key before this SDK is rebuilt — fetch the authoritative public key and
build your own keyring:

```go
c := kolm.NewClientFromEnv()
k, _ := c.IssuerKey(ctx) // GET /v1/audit/issuer-key (public)
keyring := []kolm.Issuer{{
    KID: "kolm-live", Status: "production", Alg: k.Alg, PublicKey: k.PublicKey,
}}
v, _ := kolm.VerifyReport(reportJSON, keyring)
```

A `demo` issuer is recognized as a kolm demo, never as production evidence —
inspect `verdict.IssuerStatus` before relying on a `Trusted()` verdict for a
compliance decision.

## Thin audit client

`Client` wraps the kolm.ai HTTP surface for the audit product. Every method takes
a `context.Context`; non-2xx responses come back as a typed `*APIError`.

```go
c := kolm.NewClientFromEnv() // KOLM_BASE_URL (default https://kolm.ai) + KOLM_API_KEY

// One-shot scan: logs in, signed report out — then verify it offline.
res, err := c.Scan(ctx, kolm.ScanRequest{
    Logs:    string(jsonlBytes), // raw JSONL text or a slice of records
    Subject: "support & billing agents",
    Source:  "litellm",
})
if err == nil && res.Signed {
    v, _ := kolm.VerifyReport(res.Report, kolm.DefaultKeyring())
    fmt.Println("trusted:", v.Trusted())
}

reports, _ := c.Reports(ctx)                       // GET  /v1/audit/reports
co, _ := c.ReportCheckout(ctx, "audses_…")          // POST /v1/audit/report/checkout
sub, _ := c.ContinuousCheckout(ctx, "starter")      // POST /v1/audit/continuous/checkout
key, _ := c.IssuerKey(ctx)                          // GET  /v1/audit/issuer-key (public)
```

| Method | Endpoint | Auth |
|--------|----------|------|
| `Scan` | `POST /v1/audit/scan` | API key |
| `Reports` | `GET /v1/audit/reports` | API key |
| `ReportCheckout` | `POST /v1/audit/report/checkout` | API key |
| `ContinuousCheckout` | `POST /v1/audit/continuous/checkout` | API key |
| `IssuerKey` | `GET /v1/audit/issuer-key` | public |
| `VerifyRemote` | `POST /v1/audit/report/verify` | public |

`VerifyRemote` is a convenience that mirrors the `/verify` web page; prefer the
offline `VerifyReport`, which needs no trust in the server.

## Failure-mode contract

- `VerifyReport` returns a **non-nil error** only when the input cannot be
  verified at all (invalid JSON, not an object, unexpected schema, no usable
  signature block, an undecodable key/signature). The returned `Verdict` is then
  the zero value and must be ignored.
- A **nil error** means verification ran to completion; inspect the `Verdict`.
  `Tier1Signature` may be false (bad signature, fingerprint mismatch, or a
  post-signing `signed_at` edit) and `Tier2Issuer` may be false (unknown key).
- Treating `err != nil || !verdict.Trusted()` as "do not trust" is always safe.
- `VerifyReport`, `Canonicalize`, and `MatchIssuer` never panic and never do I/O.

## License

Licensed under Apache-2.0, governed by the LICENSE at the kolm repository root (the same license as the Python SDK).
