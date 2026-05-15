# Model card — HIPAA PHI redactor

> Auditor-facing template. Fill in the bracketed sections after compile.

## Intended use

A single-purpose redaction model that processes clinical text and returns
the same text with each Protected Health Information (PHI) span replaced
by a neutral tag. Designed to be a first-pass control in a documented
de-identification workflow, not a substitute for §164.514(b)(1) Expert
Determination.

## Out-of-scope use

- **Not a de-identification certifier.** A separate Expert Determination
  is required if the output is used to assert Safe Harbor compliance.
- **Not a synthetic data generator.** The model is trained to redact, not
  invent.
- **Not an extractor.** The model is trained to refuse PHI extraction
  prompts (`policy.refuses` in `recipe.json`).

## Training data lineage

| Field                          | Value                            |
| ------------------------------ | -------------------------------- |
| Source                         | [BUYER fills in: source datasets] |
| Total examples (post-dedup)    | [N]                              |
| Synthetic share                | [N%]                             |
| Held-out share                 | 15%                              |
| PHI present in training set?   | [yes/no — explain]               |
| Data residency during training | [region]                         |
| Compile timestamp              | [from receipt]                   |
| Compile machine fingerprint    | [from receipt]                   |

## Evaluation

| Metric          | Definition                                              | Result   |
| --------------- | ------------------------------------------------------- | -------- |
| Precision       | Of all spans the model redacted, fraction that were PHI | [from K] |
| Recall          | Of all true PHI spans, fraction the model redacted      | [from K] |
| F1              | Harmonic mean                                           | [from K] |
| Leak rate       | Held-out outputs containing un-redacted PHI / total     | [0.000]  |
| Over-redaction  | Held-out outputs with non-PHI text incorrectly tagged   | [N]      |
| K-score         | Composite kolm gate (≥0.92 required to ship)            | [0.xxx]  |

All numbers are reproducible from the artifact CID using
`kolm eval <cid> --pack hipaa-phi-redactor`.

## Drift monitoring

- The artifact is a fixed binary; behavior does not drift on its own.
- Drift can only come from *input distribution shift* (new note types,
  new departments). The dashboard's K-score panel re-evaluates on a
  rolling sample and raises if precision/recall drop below the floor.

## Failure modes documented

1. **Novel identifier formats** (international IDs, custom MRN schemes) —
   may leak. Mitigation: add 20-50 examples per format and recompile.
2. **OCR artifacts** — model is trained on clean text. Pre-process OCR
   output through a normalizer before redaction.
3. **Code-switching** — predominantly English-trained. Multilingual
   notes need a pack extension (planned).

## Receipt chain

The artifact ships with `receipt.json` and `credential.json`:

- `receipt.json` — HMAC-SHA256 chain of training stages, hashed in order,
  signed by the compile host.
- `credential.json` — kolm-credential/0.1 schema: artifact_hash, cid,
  k_score, base_model, signed_at. Signature deterministic.

Anyone with access to the buyer's receipt secret can replay verification
with `kolm inspect <artifact.kolm> --verify strict`.

## Contact

[BUYER security contact]
