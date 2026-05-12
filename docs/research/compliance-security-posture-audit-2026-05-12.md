# Compliance And Security Posture Audit

Date: 2026-05-12

Scope: local review of public security, privacy, terms, BAA/DPA, healthcare, enterprise, legal, audit-log, pricing/trust claims, disclosure files, CI/release artifacts, and relevant route implementations. External context was limited to official/legal primary sources: HHS HIPAA business-associate guidance, EUR-Lex GDPR Article 28, FTC Health Breach Notification Rule guidance, and RFC 9116.

This is a product-readiness audit, not legal advice.

## Executive Findings

1. P0/P1: regulated-data deletion and retention promises are ahead of implementation. Public pages promise 30-day account/PHI destruction, 90-day job metadata deletion, account export/delete CLI flows, and observation purge, but current code mostly soft-deletes tenant auth and lacks retention jobs, purge routes, export CLI, or deletion certificates.
2. P1: the audit-log surface is mostly a stub. `/audit-log` describes per-tenant durable JSON/CSV logs and opt-in behavior, while `/v1/audit/log` returns a 503 beta envelope and no `/v1/account/audit-log` route exists.
3. P1: capture privacy needs clearer boundaries. Upstream provider keys are not persisted, but prompt and response text are stored automatically in `observations` up to 8000/16000 characters without purge, retention, or redaction controls.
4. P1: supply-chain claims need backing artifacts. The security page says Sigstore is live, Cosign signatures exist, SBOMs are published, and release tags trigger provenance builds; no matching local workflows, SBOMs, provenance, or signing artifacts were found.
5. P1: healthcare/legal/enterprise pages are persuasive but must draw a harder line between architecture target, customer-hosted Enterprise design, and the current hosted product. PHI/client-document copy should not imply end-to-end regulated readiness unless BAA, bridge, retention, audit, and subprocessor controls are implemented for that deployment.

## Legal Source Context

HHS states that covered entities may disclose PHI to business associates when they obtain satisfactory assurances that the business associate will use PHI only for the engaged purpose, safeguard it, and help the covered entity meet certain HIPAA duties: https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html

EUR-Lex GDPR Article 28 requires processor contracts and controls around documented instructions, subprocessors, assistance with data-subject rights, security, audits, and delete/return at service end: https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng

FTC guidance says the Health Breach Notification Rule can apply to non-HIPAA personal health record vendors, related entities, and third-party service providers, including some health apps and similar technologies: https://www.ftc.gov/business-guidance/resources/health-breach-notification-rule-basics-business

RFC 9116 defines `security.txt` as a machine-readable vulnerability disclosure mechanism and expects a well-known HTTPS location, contact fields, and current referenced resources: https://www.rfc-editor.org/rfc/rfc9116

## What Is Supported

- `security.txt` exists under `public/.well-known/security.txt`, and `server.js` serves both `/.well-known/security.txt` and `/security.txt`.
- The PGP disclosure page/fingerprint is present as a text file, though key material needs verification and an actual `.asc` artifact.
- Upstream API keys in capture proxy routes are taken from explicit upstream headers and are not stored in `observations`.
- The product has useful raw materials for compliance evidence: HMAC receipts, K-score/eval artifacts, route-level auth, account records, compile job metadata, and public/private registry state.

## Gaps To Fix Before Regulated Sales

Highest priority:

- Implement tenant purge/export/certificate controls or narrow all deletion language to current soft-delete behavior.
- Implement observation purge, capture retention, redaction-before-persist, and namespace deletion controls.
- Either ship durable audit logs or make `/audit-log` visibly beta and remove instructions for missing opt-in/purge routes.
- Publish actual BAA/DPA/MSA artifacts with owners, dates, and versioning before presenting them as founder-signable deliverables.
- Build a subprocessor register tied to deployment topology and data categories.
- Publish real SBOM/provenance/signature artifacts or mark Sigstore/SBOM/SLSA claims as roadmap.
- Separate hosted-product limitations from customer-hosted Enterprise architecture on healthcare/legal pages.

## Recommended Contract Wording Rule

Until controls exist, public pages should use one of three labels:

- `shipped`: backed by code, tests, and a reproducible command.
- `manual`: possible by founder/operator process, with owner and SLA.
- `planned`: not available yet and not part of current customer commitments.

Every BAA/DPA/privacy/security claim should carry one of those labels internally before it goes live.

See `compliance-security-posture-matrix-2026-05-12.csv` for row-level evidence and actions.
