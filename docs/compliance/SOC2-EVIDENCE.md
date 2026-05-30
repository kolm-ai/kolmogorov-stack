# SOC 2 Type II — Evidence Pack (Control-by-Control Matrix)

> **Scope:** Kolmogorov Stack platform (API, CLI, web surfaces).
> **Framework:** AICPA Trust Services Criteria (TSC) 2017, as revised — Security (Common Criteria CC1–CC9), Availability (A1), Confidentiality (C1), Processing Integrity (PI1), Privacy (P-series referenced where implemented).
> **Type II note:** This pack maps each criterion to the *system control as implemented in code*. SOC 2 **Type II** additionally requires an auditor to test *operating effectiveness over a period* (typically 3–12 months). Where a control is implemented in code but the longitudinal operating evidence (ticket logs, sampled runs, signed reviews over the audit window) is a process the organization must run, the status is marked **process-only** or **partial**. **No control below is asserted unless the cited file exists in this repository.**

## How to read the status column

| Status | Meaning |
|---|---|
| **Implemented** | The control logic ships as code in the cited file; behavior is enforced at runtime. |
| **Partial** | Core mechanism ships in code, but completeness depends on configuration, a paid tier/entitlement gate, or an operational step not fully automated. |
| **Process-only** | The repository provides supporting tooling/artifacts, but the control is primarily an organizational process (e.g., personnel, vendor reviews) that lives outside this codebase and must be evidenced by the operator. |

All file paths are relative to the repository root. Routes are served by the platform router (`src/router.js`) and `server.js`; per the change-management constraints of this repository, route wiring is documented, not modified, here.

---

## CC1 — Control Environment (Governance, Integrity, Accountability)

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| CC1.1 Integrity & ethical values | Signed-artifact provenance establishes a verifiable chain of accountability for every produced artifact (who/what produced it). | `src/provenance.js`, `src/ed25519.js` | Implemented |
| CC1.2 Board / oversight independence | Organizational oversight (board, security committee) is an out-of-code governance process. | — (organizational) | Process-only |
| CC1.3 Roles & responsibilities (structure) | Role-based access model defines named roles and the permissions each carries. | `src/rbac.js` | Implemented |
| CC1.4 Competence | Personnel competence / training records are an HR process. | — (organizational) | Process-only |
| CC1.5 Accountability | RBAC + immutable audit logging tie actions to principals; signing keys attribute artifacts. | `src/rbac.js`, `src/audit.js`, `src/ed25519.js` | Implemented |

---

## CC2 — Communication & Information

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| CC2.1 Quality information for control | Structured, queryable audit event store records security-relevant events with tenant attribution. | `src/audit.js`, `src/audit-export.js` | Implemented |
| CC2.2 Internal communication of responsibilities | Compliance/control documentation distributed in-repo. | `docs/compliance/SOC2-EVIDENCE.md`, `docs/compliance/CONTROLS.md`, `docs/compliance-certification-packet.md` | Implemented |
| CC2.3 External communication | Customer-facing compliance packet & exportable evidence (audit export, SBOM). | `src/audit-export.js`, `src/sbom-emit.js`, `docs/compliance-certification-packet.md` | Partial |

---

## CC3 — Risk Assessment

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| CC3.1 Objectives specified | Spend/usage caps express financial-exposure objectives enforced at runtime. | `src/spend-caps.js` | Implemented |
| CC3.2 Risk identification | Drift / anomaly detection identifies operational and model-behavior risk. | `src/drift-alert.js`, `src/continuous-monitoring.js` | Partial |
| CC3.3 Fraud risk | Anomaly detection over capture/usage streams; spend caps bound abuse blast radius. | `src/spend-caps.js`, `src/continuous-monitoring.js` | Partial |
| CC3.4 Change risk assessment | Pre-release verification gates assess risk before ship (see CC8). | `package.json` (`release-verify`/test scripts), `scripts/` | Partial |

---

## CC4 — Monitoring Activities

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| CC4.1 Ongoing evaluations | Continuous-monitoring module performs ongoing checks; telemetry exported for evaluation. | `src/continuous-monitoring.js`, `src/otel.js`, `src/prometheus-exporter.js` | Implemented |
| CC4.2 Deficiency communication | Drift/alert pipeline surfaces deficiencies to operators. | `src/drift-alert.js`, `src/notifications.js` | Partial |

---

## CC5 — Control Activities

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| CC5.1 Control selection | RBAC, residency, spend caps, secrets handling are the selected control activities (see CC6). | `src/rbac.js`, `src/data-residency.js`, `src/spend-caps.js`, `src/secrets-vault.js` | Implemented |
| CC5.2 Technology controls | Cryptographic signing + verification embedded in the artifact pipeline. | `src/ed25519.js`, `src/ensure-signing-key.js`, `src/provenance.js` | Implemented |
| CC5.3 Policies & procedures | Documented controls + runbooks. | `docs/compliance/CONTROLS.md`, `docs/runbook-alerts.md`, `docs/runbook-rollback.md` | Implemented |

---

## CC6 — Logical & Physical Access Controls *(core Security criterion)*

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| CC6.1 Logical access — authentication | API-key authentication with hashed key storage; tenant identity resolution; `whoami` identity endpoint. | `src/auth.js`, `src/keys.js` | Implemented |
| CC6.1 Logical access — SSO/SAML | Enterprise SSO via SAML 2.0 ACS + IdP metadata handling. | `src/saml-acs.js` | Partial (enterprise-tier gated) |
| CC6.2 Provisioning / de-provisioning | SCIM 2.0 user & group provisioning (Users, Groups, ServiceProviderConfig) for lifecycle management. | `src/scim-provisioning.js` | Partial (enterprise-tier gated) |
| CC6.3 Role-based authorization | RBAC role→permission model gates privileged operations. | `src/rbac.js` | Implemented |
| CC6.4 Physical access | Hosting (Vercel/Railway/cloud) physical security inherited from sub-processors; covered by their SOC 2 reports. | — (sub-processor; inherited) | Process-only |
| CC6.5 Data disposal | Audit-log retention enforces time-bounded disposal; capture-forget supports record deletion. | `src/audit-retention.js`, `src/capture-forget.js` | Implemented |
| CC6.6 External-access protections | Authentication required on protected routes; rate limiting / public-path allowlist in auth layer. | `src/auth.js` | Implemented |
| CC6.7 Restricting data movement | Data-residency enforcement constrains where tenant data is stored/processed; BYOC keeps data in customer cloud. | `src/data-residency.js`, `src/byoc.js` | Partial |
| CC6.8 Malicious-software protections | Dependency provenance (SBOM) + signed artifacts establish supply-chain integrity. | `src/sbom-emit.js`, `src/ed25519.js` | Partial |

---

## CC7 — System Operations *(detection, monitoring, incident response)*

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| CC7.1 Detection of vulnerabilities/config drift | Drift detection + continuous monitoring; SBOM enables dependency-vulnerability review. | `src/drift-alert.js`, `src/continuous-monitoring.js`, `src/sbom-emit.js` | Partial |
| CC7.2 Monitoring of anomalies | Telemetry (OpenTelemetry) + Prometheus metrics + health endpoint; anomaly detection over usage. | `src/otel.js`, `src/prometheus-exporter.js`, `src/continuous-monitoring.js`; `/health`, `/metrics` | Implemented |
| CC7.3 Evaluation of security events | Audit event store retains security-relevant events for investigation; exportable for review. | `src/audit.js`, `src/audit-export.js` | Implemented |
| CC7.4 Incident response | Documented rollback / alert runbooks drive response. | `docs/runbook-alerts.md`, `docs/runbook-rollback.md` | Partial (runbooks present; drill cadence is operator process) |
| CC7.5 Recovery | Rollback runbook + deploy rollback/canary tooling for recovery. | `docs/runbook-rollback.md`, `src/deploy-canary.js`, `src/deploy-rolling.js` | Partial |

---

## CC8 — Change Management

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| CC8.1 Authorized, tested, documented changes | Pre-release verification gates (tests + claim/route/billing checks) run before ship; canary/rolling deploy controls staged rollout; change history in version control + changelog. | `package.json` (`test` / `release-verify` scripts), `scripts/`, `src/deploy-canary.js`, `src/deploy-rolling.js`, `CHANGELOG.md` | Partial (gates implemented; mandatory-gate enforcement & approvals are operator policy) |

---

## CC9 — Risk Mitigation

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| CC9.1 Risk mitigation (business disruption) | Spend caps bound financial exposure; canary/rolling deploy limit blast radius; rollback runbook. | `src/spend-caps.js`, `src/deploy-canary.js`, `docs/runbook-rollback.md` | Partial |
| CC9.2 Vendor / sub-processor management | Vendor/sub-processor risk review is an organizational process; BYOC reduces vendor data-exposure surface. | `src/byoc.js`; vendor reviews (organizational) | Process-only |

---

## A1 — Availability

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| A1.1 Capacity monitoring | Metrics + health endpoint expose load/capacity signals. | `src/prometheus-exporter.js`, `/health`, `/metrics` | Implemented |
| A1.2 Backup / DR / environmental | Rollback runbook + deploy controls; data durability inherited from hosting sub-processors. | `docs/runbook-rollback.md`, `src/deploy-rolling.js` | Partial |
| A1.3 Recovery testing | Recovery procedure documented; periodic test execution is operator process. | `docs/runbook-rollback.md` | Process-only |

---

## C1 — Confidentiality

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| C1.1 Confidential-data identification/handling | Secrets vault isolates credentials; PII/PHI redactors protect sensitive content; residency restricts location. | `src/secrets-vault.js`, `src/pii-redactor.js`, `src/phi-redactor.js`, `src/data-residency.js` | Implemented |
| C1.2 Confidential-data disposal | Retention-based disposal + capture-forget. | `src/audit-retention.js`, `src/capture-forget.js` | Implemented |

---

## PI1 — Processing Integrity

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| PI1.1 Processing definitions / provenance | End-to-end provenance + signed receipts make processing verifiable. | `src/provenance.js`, `src/ed25519.js`, `src/audit.js` | Implemented |
| PI1.2 Inputs completeness/accuracy | Output schema enforcement / constrained decoding validate produced outputs. | `src/output-schema.js`, `src/constrained-decode.js` | Partial |
| PI1.3–PI1.5 Processing/output integrity & verification | Tamper-evident audit log (hash-chained / signed) + independent verification endpoint allow processing outputs to be re-verified. | `src/audit.js`, `src/audit-export.js`, `src/ed25519.js` | Partial |

---

## Privacy (P-series) — implemented data-subject controls

| Criterion | Control (as implemented) | Evidence (file / route) | Status |
|---|---|---|---|
| P4 / P-disposal (right to erasure) | Capture-forget deletes subject records; retention bounds storage time. | `src/capture-forget.js`, `src/audit-retention.js` | Implemented |
| P-minimization | PII/PHI redaction minimizes sensitive-data retention. | `src/pii-redactor.js`, `src/phi-redactor.js` | Implemented |
| P-location | Residency controls + BYOC constrain where personal data resides. | `src/data-residency.js`, `src/byoc.js` | Partial |

---

## Evidence-collection guidance for the Type II audit window

For a SOC 2 **Type II** engagement, the auditor samples *operating effectiveness over the period*. For each **Implemented** / **Partial** control above, collect:

1. **Access control (CC6):** export of RBAC role assignments; sample of SSO/SCIM provisioning + de-provisioning events; sampled denied-access audit entries.
2. **Operations (CC7):** monitoring dashboards / alert history; sampled incident tickets mapped to the runbooks; `/health` + `/metrics` retention.
3. **Change management (CC8):** version-control history + changelog; CI/`release-verify` run logs across the window; canary/rollback records.
4. **Audit integrity (CC2/CC7/PI1):** periodic audit-log export + signature/hash-chain verification runs proving tamper-evidence held over the period.
5. **Confidentiality/Privacy (C1/P):** sampled redaction outputs; residency configuration snapshots; erasure-request fulfillment records.

## Caveats

- This matrix reflects controls **present in source code as of the repository state when written**. It is engineering input to an audit, **not** a SOC 2 report and **not** an auditor attestation.
- Statuses marked **partial** depend on tier/entitlement gating (notably SSO/SCIM at enterprise tier), configuration, or an operational step. Statuses marked **process-only** require organizational evidence outside this codebase.
- Physical security, sub-processor controls, and personnel controls are inherited or organizational and are out of scope for code-level evidence.
