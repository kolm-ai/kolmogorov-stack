# Compliance packs

Pre-built recipe scaffolds + auditor-facing evidence templates for the
three onboarding paths kolm is most often pulled into:

| Pack                          | Buyer                                    | Authority           |
| ----------------------------- | ---------------------------------------- | ------------------- |
| `hipaa-phi-redactor/`         | Health plans, payers, providers          | HIPAA Privacy Rule  |
| `finance-sr11-7/`             | Banks, asset managers, BHCs              | Fed SR 11-7, OCC 2011-12 |
| `sox-lite/`                   | Public-co finance / IR / controls teams | SOX 404, COSO       |

Each pack contains:

- `README.md`          — what the pack does, who reviews it
- `recipe.json`        — drop-in scaffold for `kolm compile --recipe recipe.json`
- `evidence.md`        — auditor-facing template: model card, intended use,
                         training data lineage, evaluation results, monitoring
- `examples/`          — public seed examples (no real PHI/PII)
- `policy.md`          — what kolm refuses to do (off-label use, jailbreaks)
- `dpia.md` *(HIPAA)*  — Data Protection Impact Assessment skeleton
- `mrm.md` *(SR 11-7)* — Model Risk Management documentation skeleton

These are starting points, not legal advice. The compiled artifact will
carry a `compliance_pack` field in its manifest so the audit log can prove
the pack was applied at compile time, but the buyer's compliance team is
still the one signing off.

## Usage

```sh
kolm compile --recipe data/compliance-packs/hipaa-phi-redactor/recipe.json \
  --examples data/compliance-packs/hipaa-phi-redactor/examples/ \
  --k 0.92
```

The `--k 0.92` floor is higher than the kolm default (0.85) because PHI
redaction has a low-tolerance failure mode (a single leak is a breach).
The SR 11-7 pack ships with `--k 0.90` for similar reasons.
