# DPIA — HIPAA PHI redactor

> Data Protection Impact Assessment skeleton. Fill in and review with
> Privacy / Compliance before production rollout.

## 1. Processing description

- **Purpose:** Redact PHI from [BUYER data class — e.g. inpatient
  discharge summaries] before [downstream use — e.g. external
  analytics partner ingestion].
- **Legal basis:** [HIPAA §164.502 / Business Associate Agreement / TPO]
- **Data minimization:** Only the fields required for the downstream
  task are passed through the redactor. Other fields are removed
  upstream.

## 2. Necessity / proportionality

- **Why a model rather than rules?** [BUYER fills: documented coverage
  gap of rule-based redactor, e.g. names embedded in free-text]
- **Why this base model?** Qwen2.5 3B Instruct: Apache 2.0 licensed,
  inferences without GPU, runs on a single-tenant host with no egress.
- **Why on-prem / TEE?** PHI never leaves the buyer's controlled
  perimeter, removing a class of risks (third-party SaaS subprocessing,
  cross-border transfer, retention by a vendor).

## 3. Risks identified

| Risk                                       | Likelihood | Severity | Mitigation                                      |
| ------------------------------------------ | ---------- | -------- | ----------------------------------------------- |
| PHI leakage in output                      | Low        | High     | K-score floor 0.92; reject below threshold; receipt audit log |
| Re-identification from incomplete redaction | Medium     | High     | Multi-stage workflow: redactor → expert review → release |
| Model memorization of training set         | Low        | Medium   | LoRA rank-16 (not full fine-tune); no public weights release |
| Prompt-injection extraction                | Low        | High     | `policy.refuses` covers extraction prompts; constrained-generation runtime |
| Drift on new note types                    | Medium     | Medium   | Dashboard K-score monitor; `kolm improve` for re-training |
| Operator misuse                            | Low        | High     | RBAC on /v1/run; audit log immutable per receipt chain |

## 4. Consultation

- **DPO / Privacy:** [name, date]
- **Compliance:** [name, date]
- **Clinical / Domain:** [name, date]
- **Security:** [name, date]

## 5. Sign-off

- [ ] Risks listed above are addressed by current mitigations
- [ ] DPO has reviewed
- [ ] Compliance has reviewed
- [ ] Recompile cadence and re-DPIA trigger are defined

**Reviewed by:** [name]
**Date:** [yyyy-mm-dd]
**Next review:** [yyyy-mm-dd]
