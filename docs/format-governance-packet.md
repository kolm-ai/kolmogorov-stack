# .kolm Format Governance Packet

This packet is the local closeout for `foundation-standardization`. It prepares
the evidence needed to submit .kolm governance to a neutral venue without
claiming that an outside venue has accepted it.

## Local Packet

- Versioned format spec: `docs/kolm-format-v1.md`
- Receipt spec: `docs/rs-1.md` and `docs/receipt-v0.1.json`
- Manifest schema: `docs/manifest-v0.1.json`
- Public spec surface: `public/spec.html`
- Readiness module: `src/format-governance-packet.js`

## Governance Proposal

- Scope: portable signed AI artifacts, manifests, receipts, runtime metadata,
  verifier behavior, and conformance fixtures.
- Compatibility: semver for .kolm format revisions; v1 runtimes must reject
  unsupported major versions and preserve verifier error codes.
- Maintainers: Kolm seeds the spec and reference verifier; external maintainers
  are added only through a public change-control process.
- IP: spec and reference verifier remain permissive; compiler and hosted
  governance services remain commercial.
- Security: signature, hash, and receipt verification rules are testable by
  standalone conformance fixtures.

## External Baseline

CNCF documents Sandbox as the primary entry point for CNCF project submission:
https://contribute.cncf.io/projects/submit-project/

The packet is not complete until a public issue, application, or foundation
intake artifact exists and is recorded in
`reports/format-governance-submission.json`.

## External Submission Manifest

```bash
node scripts/format-governance-packet.mjs --template
node scripts/format-governance-packet.mjs --validate reports/format-governance-submission.json
```

The manifest must stay secret-free and prove accepted neutral governance with
HTTPS submission/change-control URLs, accepted venue status, conformance-suite
hash, spec hash, maintainer-policy hash, trademark-policy hash, and accepted
scope. Each hash must point at a retained local artifact under
`reports/format-governance/` so the audit can hash-match the retained packet
before promoting the gate. A placeholder, submitted-only record, or manifest
without retained artifacts must not clear the external gate.
