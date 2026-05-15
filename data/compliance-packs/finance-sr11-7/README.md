# Finance SR 11-7 pack

Compile a model that classifies financial transactions, flags suspicious
activity, or extracts structured fields from regulated documents — under
the Fed SR 11-7 / OCC 2011-12 Model Risk Management regime.

## What this pack outputs

A `.kolm` artifact whose `predict(input)` returns a strict JSON object
the buyer's downstream system can rely on without parsing prose:

```json
{
  "category": "transfer | payment | fee | interest | other",
  "amount": 1234.56,
  "currency": "USD",
  "counterparty": "string or null",
  "flags": ["aml" | "ofac" | "structuring" | ...],
  "confidence": 0.94
}
```

Schema is enforced via the kolm constrained-decoding runtime — outputs
that fall outside the schema are rejected at inference time, not
parsed-then-prayed-for.

## Why SR 11-7 lines up

SR 11-7 cares about three things; this pack maps to each:

| SR 11-7 element                              | What kolm provides                          |
| -------------------------------------------- | ------------------------------------------- |
| Sound development, implementation, use        | Reproducible compile (CID, receipt chain), K-score gate, held-out eval, model card |
| Effective challenge / independent validation  | `evidence.md` model card; eval pack designed to be re-run by a 2nd-line team |
| Robust governance / policies / controls       | `mrm.md` MRM doc skeleton; immutable audit log; recompile cadence policy |

This pack does not replace your MRM function. It gives your MRM team
the artifacts they expect to receive on day one of an inventory review.

## Quickstart

```sh
kolm compile \
  --recipe data/compliance-packs/finance-sr11-7/recipe.json \
  --examples data/compliance-packs/finance-sr11-7/examples/ \
  --k 0.90
```

See `mrm.md` for the Model Risk Management documentation template.
