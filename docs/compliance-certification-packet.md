# Compliance Certification Packet

This packet is the local evidence spine for compliance review. It does not claim
live certification. It records which implementation-control surfaces exist and
which third-party artifacts still have to be attached before public trust copy
can say SOC 2, ISO 27001, HIPAA, GDPR, FedRAMP, SLSA, or SBOM evidence is
complete.

## Local Evidence

| Control | Local evidence | External blocker |
| --- | --- | --- |
| SOC 2 | `/security`, `/soc2` | Dated auditor report |
| ISO 27001 | `/security` | Issued certificate and statement of applicability |
| HIPAA BAA | `/baa`, `/hipaa-mapping` | Signed BAA or counsel-approved packet |
| GDPR DPA | `/privacy`, `/subprocessors` | Legal-reviewed DPA and SCC packet |
| FedRAMP | `/security`, `/sbom` | Authorized boundary and assessor artifacts |
| SLSA/SBOM | `/slsa`, `/sbom`, SDK CI | Signed release provenance and package digests |

## Verification

```bash
npm run verify:compliance-packet
node scripts/compliance-certification-packet.mjs --template
node scripts/compliance-certification-packet.mjs --validate reports/compliance-certification-manifest.json
```

The gate fails if local evidence files disappear. It stays `needs_live_certification`
until external auditor/legal/release artifacts are attached.

## External Evidence Manifest

`reports/compliance-certification-manifest.json` is the promotion file for the
live certification gate. It must stay secret-free and include:

- SOC 2, ISO 27001, HIPAA BAA, GDPR DPA, FedRAMP, and SLSA/SBOM rows.
- HTTPS evidence URLs, SHA-256 evidence hashes, and SHA-256 signature hashes.
- production `/health`, `/ready`, and authenticated-probe hashes.
- issuer, issued date, scope summary, tenant boundary, and data region.

Without that manifest, the packet can prove implemented controls but not a live
certification claim.
