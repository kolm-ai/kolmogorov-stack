# Compliance Certification Packet

This packet is the local evidence spine for compliance review. It does not claim
live certification. It records which implementation-control surfaces exist and
which third-party artifacts still have to be attached before public trust copy
can say SOC 2, ISO 27001, HIPAA, GDPR, FedRAMP, SLSA, or SBOM evidence is
complete.

## Local Evidence

| Control | Local evidence | External blocker |
| --- | --- | --- |
| SOC 2 | `/security`, `docs/compliance/SOC2-EVIDENCE.md`, `docs/compliance/CONTROLS.md` | Dated auditor report |
| ISO 27001 | `/security`, `docs/compliance/CONTROLS.md` | Issued certificate and statement of applicability |
| HIPAA BAA | `/baa`, `docs/angle/hipaa-onepager.html` | Signed BAA or counsel-approved packet |
| GDPR DPA | `/privacy`, `/subprocessors` | Legal-reviewed DPA and SCC packet |
| FedRAMP | `/security`, `docs/compliance/CONTROLS.md`, `docs/kolm-format-v1.md` | Authorized boundary and assessor artifacts |
| SLSA/SBOM | `docs/kolm-format-v1.md`, `src/sbom-emit.js`, `src/slsa-provenance.js`, SDK CI | Signed release provenance and package digests |

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
live certification gate. It must stay secret-free, placeholder-free, and include:

- SOC 2, ISO 27001, HIPAA BAA, GDPR DPA, FedRAMP, and SLSA/SBOM rows.
- Authority references for AICPA TSC, ISO/IEC 27001, HHS HIPAA Security Rule,
  EU GDPR, FedRAMP Rev. 5 baselines, NIST SP 800-53 Rev. 5, SLSA Provenance
  v1.0, in-toto Statement v1, and SPDX specifications as applicable.
- Framework crosswalk references for each row, including SOC 2 CC1-CC9,
  ISO/IEC 27001 clauses/Annex A, HIPAA 45 CFR safeguards, GDPR processor and
  security articles, FedRAMP/NIST baselines, and SLSA/in-toto/SPDX supply-chain
  evidence.
- HTTPS evidence URLs, retained `reports/compliance/...` evidence artifact
  paths, retained evidence-register artifact paths, retained signature artifact
  paths, and SHA-256 hashes for all three retained artifacts.
- production `/health`, `/ready`, and authenticated-probe hashes.
- issuer, issued date, expiration date, control-period start/end, scope summary,
  system boundary, tenant boundary, and data region.
- Chain-of-custody metadata naming who collected the evidence, who reviewed it,
  reviewer independence (`external_auditor`, `external_counsel`, or
  `internal_independent_reviewer`), retention date, and matching evidence
  register path/hash.

`--validate` checks the manifest schema and reports when it is ready for local
artifact verification. It does not claim live certification by itself. The audit
only promotes `live_certification_verified=true` after the manifest validates
and all retained evidence, evidence-register, and signature files exist with
matching hashes. Without that complete retained-artifact set, the packet can
prove implemented controls but not a live certification claim.
