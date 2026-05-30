# Control Inventory

A short index of the security/compliance controls that ship as code in this repository.
Each row cites the implementing file. For the full Trust Services Criteria mapping and
implemented / partial / process-only status, see [`SOC2-EVIDENCE.md`](./SOC2-EVIDENCE.md).

> Citation rule: every file below was confirmed to exist in `src/`. Route wiring lives in
> `src/router.js` / `server.js` and is documented, not modified, here.

## Access control & identity (CC6)

| Control | Implementing file |
|---|---|
| API-key authentication, hashed key storage, tenant resolution, identity (`whoami`) | `src/auth.js`, `src/keys.js` |
| Role-based access control (role → permission model) | `src/rbac.js` |
| Enterprise SSO — SAML 2.0 ACS + IdP metadata | `src/saml-acs.js` |
| SCIM 2.0 provisioning / de-provisioning (Users, Groups, ServiceProviderConfig) | `src/scim-provisioning.js` |
| Per-tenant capture authorization | `src/team-capture-rbac.js` |

## Auditability & accountability (CC2, CC7, PI1)

| Control | Implementing file |
|---|---|
| Audit event store (security-relevant events, tenant-attributed) | `src/audit.js` |
| Audit export + independent verification (tamper-evidence) | `src/audit-export.js` |
| Audit-log retention / disposal | `src/audit-retention.js` |
| Transparency log | `src/transparency-log.js` |

## Cryptographic integrity & provenance (CC5, PI1)

| Control | Implementing file |
|---|---|
| Ed25519 signing / verification | `src/ed25519.js` |
| Signing-key bootstrap / management | `src/ensure-signing-key.js` |
| Artifact provenance chain | `src/provenance.js` |
| Software bill of materials (SBOM) | `src/sbom-emit.js` |
| Sigstore / keyless signing support | `src/sigstore.js` |

## Confidentiality & data protection (C1, Privacy)

| Control | Implementing file |
|---|---|
| Secrets vault (credential isolation) | `src/secrets-vault.js` |
| PII redaction | `src/pii-redactor.js` |
| PHI redaction | `src/phi-redactor.js` |
| Data residency enforcement | `src/data-residency.js` |
| Bring-your-own-cloud (data stays in customer cloud) | `src/byoc.js` |
| Right-to-erasure / capture forget | `src/capture-forget.js` |

## Monitoring & operations (CC4, CC7, A1)

| Control | Implementing file / route |
|---|---|
| Continuous monitoring | `src/continuous-monitoring.js` |
| Drift / anomaly alerting | `src/drift-alert.js` |
| OpenTelemetry instrumentation | `src/otel.js` |
| Prometheus metrics exporter | `src/prometheus-exporter.js` |
| Health / metrics endpoints | `/health`, `/metrics` |
| Notifications / alert delivery | `src/notifications.js` |

## Risk mitigation & change management (CC3, CC8, CC9)

| Control | Implementing file / artifact |
|---|---|
| Spend / usage caps (financial-exposure limits) | `src/spend-caps.js` |
| Canary deploys | `src/deploy-canary.js` |
| Rolling deploys | `src/deploy-rolling.js` |
| Pre-release verification gates | `package.json` (`test` / `release-verify` scripts), `scripts/` |
| Change history | `CHANGELOG.md`, version control |
| Output schema / constrained decoding (processing integrity) | `src/output-schema.js`, `src/constrained-decode.js` |

## Runbooks & documentation

| Document | Path |
|---|---|
| Alert runbook | `docs/runbook-alerts.md` |
| Rollback runbook | `docs/runbook-rollback.md` |
| Compliance certification packet | `docs/compliance-certification-packet.md` |
| SOC 2 evidence matrix | `docs/compliance/SOC2-EVIDENCE.md` |

## Out of scope at code level (process-only / inherited)

- Physical security and environmental controls — inherited from hosting sub-processors (Vercel / Railway / cloud), covered by their own SOC 2 reports.
- Personnel controls (background checks, training, onboarding/offboarding HR steps).
- Vendor / sub-processor risk reviews.
- Board / management oversight and risk-committee governance.

These require organizational evidence collected by the operator during the audit window and are not implemented in this codebase.
