# HIPAA PHI redactor pack

Compile a model that redacts Protected Health Information (PHI) from
clinical text, claims notes, member correspondence, or pharmacy records.

## What this pack outputs

A `.kolm` artifact whose `predict(input)` returns the same text with
every PHI span replaced by a neutral tag:

| HIPAA Safe Harbor identifier             | Replacement |
| ---------------------------------------- | ----------- |
| Names                                    | `[NAME]`    |
| Geographic units smaller than a state    | `[GEO]`     |
| Dates (other than year) related to a person | `[DATE]` |
| Telephone / fax numbers                  | `[PHONE]`   |
| Email addresses                          | `[EMAIL]`   |
| Social Security numbers                  | `[SSN]`     |
| Medical record numbers                   | `[MRN]`     |
| Health plan beneficiary numbers          | `[POLICY]`  |
| Account numbers                          | `[ACCT]`    |
| Certificate / license numbers            | `[ID]`      |
| Vehicle identifiers                      | `[VIN]`     |
| Device identifiers                       | `[DEVICE]`  |
| URLs                                     | `[URL]`     |
| IP addresses                             | `[IP]`     |
| Biometric identifiers (full-face / voice) | `[BIO]`    |
| Photographic identifiers                 | `[PHOTO]`   |
| Any other unique identifier              | `[ID]`      |

This is the §164.514(b)(2) Safe Harbor list. The artifact does not claim
de-identification certification — that requires either an expert
determination (§164.514(b)(1)) or independent audit. What we ship is a
production-grade first-pass redactor that takes a buyer's compliance
team from blank page to working tool in under two hours.

## Why kolm is a fit here

- **Data never leaves your tenant.** Compile and run on your hardware.
  The training pipeline is local-first by design.
- **Receipt chain.** Every redaction carries a CID + HMAC signature so
  the audit log can prove which artifact produced which output.
- **K-score gate.** Default 0.92 (above kolm's 0.85 baseline) — the
  artifact will not ship if precision drops below the policy floor.
- **No-egress runtime.** TEE deploy options on AWS Nitro / GCP CVM if
  remote inference is needed; otherwise stays on-prem.

## Quickstart (2-hour onboarding)

```sh
# 1. Add your seed examples (anonymized clinical notes, 50+ rows)
cp your-seeds.jsonl data/compliance-packs/hipaa-phi-redactor/examples/

# 2. Compile
kolm compile \
  --recipe data/compliance-packs/hipaa-phi-redactor/recipe.json \
  --k 0.92

# 3. Eval against the held-out set
kolm eval <artifact-id> --pack hipaa-phi-redactor

# 4. Deploy
kolm run <artifact-id> --port 8080
# or: kolm export --backend gguf  # for edge / desktop / mobile
```

See `evidence.md` for the auditor-facing model card template and
`dpia.md` for the Data Protection Impact Assessment skeleton.
