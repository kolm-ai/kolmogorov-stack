// Package kolm is the Go SDK for kolm.ai Agent Security-Review evidence reports.
//
// Its headline capability is fully OFFLINE verification of a signed kolm audit
// report: a buyer's Go or Java security team can confirm — with no network call,
// no kolm account, and no shared secret — that the evidence JSON a vendor handed
// them was signed by the holder of the embedded Ed25519 public key and has NOT
// been altered since (a downgraded readiness number, a deleted finding, or a
// flipped tamper-evident flag all break the check).
//
// # Two-tier verdict
//
// [VerifyReport] returns a [Verdict] with two independent booleans:
//
//   - Tier1Signature — the report is signed by the holder of the embedded key
//     and the canonical payload is untampered (pure Ed25519 cryptography).
//   - Tier2Issuer — that embedded key is one kolm publishes, i.e. it matches an
//     entry in the trusted issuer keyring (see [DefaultKeyring]).
//
// A report is only trustworthy when BOTH are true ([Verdict.Trusted]). Checking
// Tier1Signature alone would accept a forgery that an attacker re-signed with
// their own key after tampering, which is exactly what Tier2Issuer defends
// against.
//
// # Byte-for-byte canonicalization
//
// The signature covers a canonical serialization of the report (recursive,
// key-sorted, whitespace-free JSON with the signature block excluded, signed
// over its UTF-8 bytes). [Canonicalize] reproduces that algorithm byte-for-byte
// against the reference implementations in src/attestation-report-builder.js
// (Node) and public/kolm-audit-verify.js (browser WebCrypto). The fidelity
// extends to ECMAScript number formatting, JSON string escaping (kolm does NOT
// HTML-escape "<", ">", "&", or "/"), UTF-16 key-sort order, and null handling.
//
// # Thin REST client
//
// [Client] wraps the kolm.ai HTTP API for the audit product: Scan, Reports,
// ReportCheckout, ContinuousCheckout, IssuerKey, and an optional server-side
// VerifyRemote. The offline path ([VerifyReport]) is the one that needs no
// server; the client is a convenience for orchestrating scans and purchases.
//
// # Building and testing
//
// This module uses only the Go standard library. Build and test it with the Go
// toolchain (Go 1.21+):
//
//	cd sdk/go
//	go vet ./...
//	go test ./...
package kolm
