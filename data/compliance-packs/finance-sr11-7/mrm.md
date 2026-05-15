# Model Risk Management — SR 11-7 documentation

> Skeleton for MRM 2nd-line review under Fed SR 11-7 / OCC 2011-12.
> Buyer's MRM team owns the final document.

## 1. Model identification

| Field                          | Value                          |
| ------------------------------ | ------------------------------ |
| Model ID                       | [artifact CID]                 |
| Model name                     | [BUYER fills]                  |
| Owner                          | [BUYER fills]                  |
| Risk tier                      | [BUYER fills: 1 / 2 / 3]        |
| Date placed in service         | [yyyy-mm-dd]                   |
| Last validation                | [yyyy-mm-dd]                   |
| Next scheduled re-validation   | [yyyy-mm-dd]                   |

## 2. Purpose and use

- **Intended use:** Classify regulated transaction data into structured
  records with explicit confidence and regulatory flags.
- **In-scope inputs:** Transaction memos, SWIFT messages, ACH
  descriptions, internal narrative fields.
- **Out-of-scope:** Credit decisions, capital adequacy, stress testing,
  market risk valuation. This is a classifier, not a decision system.
- **Downstream consumers:** [BUYER fills — alerting pipeline, manual
  review queue, BSA filings.]

## 3. Theory and methodology

- **Approach:** Supervised fine-tuning (LoRA, rank 32) on top of an
  Apache-2.0-licensed transformer base. Constrained decoding at
  inference enforces the output schema.
- **Why not a rule engine?** Documented coverage gap on free-text memos
  where rules either miss or over-flag (false positive rate above
  policy threshold). Recall on the held-out set is materially higher
  for the trained model.
- **Why not a frontier API?** Data classification (NPI / PII / GLBA-
  governed) prohibits sending transaction text to external endpoints.
  On-prem / TEE deployment is required.

## 4. Data

| Field                                | Value                  |
| ------------------------------------ | ---------------------- |
| Source                               | [internal pipeline]    |
| Time window                          | [yyyy-mm to yyyy-mm]   |
| Total records                        | [N]                    |
| Held-out share                       | 20%                    |
| Class balance                        | [table per category]   |
| Synthetic share                      | [N%]                   |
| Geographic / business unit coverage  | [BUYER fills]          |
| PII / NPI handling                   | Local-only; no egress  |
| Sampling bias                        | [BUYER fills]          |

## 5. Implementation

- **Reproducibility:** Receipt chain HMAC-SHA256, CID
  `cidv1:sha256:<64-hex>` over canonical-JSON of manifest hashes. Anyone
  with the receipt secret can reproduce verification deterministically.
- **Deployment surface:** [on-prem / TEE / both]
- **Latency:** [p50 / p95 / p99 ms]
- **Versioning:** Each recompile produces a new CID. Prior versions
  retained for audit per policy retention window.

## 6. Performance

| Metric              | Definition                                  | Result   | Threshold |
| ------------------- | ------------------------------------------- | -------- | --------- |
| Accuracy            | Top-1 category match                        | [0.xxx]  | ≥ 0.95    |
| Macro F1            | Average F1 across categories                | [0.xxx]  | ≥ 0.92    |
| Calibration ECE     | Expected Calibration Error of confidence    | [0.xxx]  | ≤ 0.05    |
| Schema compliance   | Outputs that parse as valid schema          | [0.xxx]  | 1.000     |
| K-score             | Composite kolm gate                         | [0.xxx]  | ≥ 0.90    |

## 7. Limitations

1. **English-dominant training.** Multilingual memos may underperform.
2. **Tail categories.** Categories with <100 training examples have wider
   confidence intervals.
3. **Distribution drift.** Sanction lists and high-risk-geo flags shift
   over time. Re-evaluate on a rolling sample monthly.
4. **Not a fraud system on its own.** The `fraud-likely` flag is one
   signal in a larger control framework.

## 8. Ongoing monitoring

- **Daily:** Schema compliance must remain 1.000. Anything else is a
  blocking incident.
- **Weekly:** Macro F1 on the rolling sample stays within 2 points of
  the original held-out result.
- **Monthly:** Calibration ECE re-measured; recalibration triggered if
  > 0.07.
- **Quarterly:** Independent validation re-run by 2nd-line MRM team.

## 9. Governance

- **Approval to deploy:** [Model Owner], [MRM Lead], [Compliance Officer]
- **Approval to retire:** Same trio plus [Business Sponsor]
- **Change control:** Any recompile that materially changes the CID
  requires a new MRM ticket. K-score regression >0.02 blocks deploy.

## 10. Sign-off

| Role            | Name | Date |
| --------------- | ---- | ---- |
| Model Owner     |      |      |
| MRM Lead        |      |      |
| Compliance      |      |      |
| Business Sponsor|      |      |
